// Where a module uses child_process and REA classified no process call: the
// places a process call may have gone unclassified. Release Watch follows
// the values REA's facts tie to child_process (process-sources: import
// bindings, a `require("child_process")` call, a local module's exports
// that hold it; process-flow: bindings REA destructures from them, the
// parameters REA passes them to) to each place they are read, and keeps the
// reads that no process site REA reported accounts for. A name counts only
// through what REA binds to child_process or a load REA did not resolve,
// never by its text alone, so a redux-saga `fork` or a game's `world.spawn`
// is not a process API.
import { within } from "../ranges.mjs";
import { moduleUses } from "./process-flow.mjs";
import { wholeHolder } from "./process-exports.mjs";
import { processGraph, rangeOf } from "./process-graph.mjs";
import {
  isRequireValue,
  loadStarts,
  mayImportProcess,
  processSites,
  seedsOf,
} from "./process-sources.mjs";
import { semanticFact } from "./provenance.mjs";

// The binding node an import edge creates: the binding of that name inside
// the edge's range, else the module's top-level binding of that name.
const importBinding = (index, site) => {
  const named = index.bindings.filter(
    (node) => node.kind === "binding" && node.label === site.data.local,
  );
  return (
    named.find(
      (node) => site.data.range && within(rangeOf(node), site.data.range),
    ) ??
    named.find((node) => !node.function_node_id) ??
    null
  );
};

// What a holder is, for the fact: its name, the child_process export it
// holds (null for the module), how Release Watch tied it to child_process
// and from which value, and the load it rests on when Release Watch only
// takes that load to be child_process.
const holderData = (holder) => ({
  receiver: holder.name,
  member: holder.member,
  via: holder.via,
  from: holder.from ?? null,
  exported: holder.exported ?? null,
  loader: holder.loader ?? null,
  heuristic: holder.heuristic === true,
});

const factOf = (use, contexts, module) => {
  const base = use.node
    ? semanticFact(use.node, contexts, "", {})
    : { ...use.site };
  const location = base.location;
  return {
    ...base,
    key: `${module}#child_process@${location?.line}:${location?.column}`,
    state: "derived",
    data: {
      module,
      use: use.kind,
      path: use.path,
      ...holderData(use.holder),
    },
  };
};

// Modules that may load a module through a require function REA does not
// resolve: a member read named `require`, a read of `eval`, `require` read
// as a value rather than called, an import of createRequire, or a load REA
// resolved to no module.
const loaderModules = (semantic, modules) => {
  const found = new Set();
  const starts = new Map();
  const startsOf = (module) => {
    if (!starts.has(module))
      starts.set(module, loadStarts(modules.get(module)));
    return starts.get(module);
  };
  for (const node of semantic.nodes) {
    const path = node.properties?.property_path;
    const module = node.identity?.module_path ?? null;
    if (path?.at(-1) === "require" || node.label === "eval") found.add(module);
    else if (node.label === "require" && isRequireValue(node, startsOf(module)))
      found.add(module);
  }
  for (const [module, entry] of modules)
    if (
      entry.unresolvedSites.length > 0 ||
      entry.externalSites.some((site) => site.data.imported === "createRequire")
    )
      found.add(module);
  found.delete(null);
  return found;
};

// Where a module's top-level bindings that hold child_process (or a
// namespace of a module that exports it) go where REA's graph does not
// show: the names an importer may find them under when REA traced no
// export (Release Watch's correlation).
const escapedNames = (module, result) => {
  const names = new Map();
  for (const use of result.uses)
    if (use.kind === "value" && use.holder.node?.kind === "binding")
      if (!use.holder.node.function_node_id)
        names.set(use.holder.name, {
          member: use.holder.member,
          namespace: use.holder.namespace ?? null,
          module,
          name: use.holder.name,
          site: null,
          commonjs: false,
          heuristic: true,
        });
  return names;
};

// The modules that import each module.
const importersOf = (modules) => {
  const importers = new Map();
  for (const [module, entry] of modules)
    for (const site of entry.localSites) {
      if (!importers.has(site.data.module))
        importers.set(site.data.module, new Set());
      importers.get(site.data.module).add(module);
    }
  return importers;
};

// Records the entries of `found` in `known`; true when one is a new key.
const addNew = (known, found) => {
  const before = known.size;
  for (const [key, value] of found) known.set(key, value);
  return known.size > before;
};

// The names under which importing all of a module holds child_process
// (`*` for module.exports or every child_process export), as a map.
const heldNames = (whole) => {
  if (!whole) return new Map();
  if (!whole.namespace || whole.namespace.star) return new Map([["*", true]]);
  return new Map([...whole.namespace.names.keys()].map((name) => [name, true]));
};

/**
 * Process gaps of one semantic graph: every place a module uses a value
 * REA ties to child_process and REA reported no process site for it.
 * `modules` is the import index and `childProcesses` the process sites
 * already projected from the graph; a module without semantic facts is
 * left to the coverage rules that report it unexamined. Modules that use
 * child_process are examined first, then the modules importing them; a
 * module that now exports child_process under more names (its bindings
 * escape under new names, Release Watch's correlation, or a module it
 * re-exports gained some) has its importers examined again, through any
 * number of local modules, until no module's names grow.
 */
export const processUnknowns = (
  semantic,
  contexts,
  { modules, childProcesses },
) => {
  const loaders = loaderModules(semantic, modules);
  const direct = new Set(
    [...modules]
      .filter(([, entry]) => processSites(entry).length > 0)
      .map(([module]) => module),
  );
  for (const module of loaders) direct.add(module);
  if (direct.size === 0) return [];
  const graph = processGraph(semantic, childProcesses);
  const escaped = new Map();
  const exports = {
    named: (module, name) => escaped.get(module)?.get(name) ?? null,
    namedList: (module) => [...(escaped.get(module)?.keys() ?? [])],
  };
  const usesOf = (module) => {
    const index = graph.include(module);
    if (!index) return null;
    const seeds = seedsOf({
      modules,
      graph,
      index,
      entry: modules.get(module),
      exports,
      importBinding,
      loaders: loaders.has(module),
    });
    return moduleUses(graph, index, seeds, importBinding);
  };
  // A module that imports a local module may hold what it exports.
  const pending = [...direct];
  for (const [module, entry] of modules)
    if (
      !direct.has(module) &&
      entry.localSites.some((site) => mayImportProcess(modules, site, direct))
    )
      pending.push(module);
  const queued = new Set(pending);
  const importers = importersOf(modules);
  const results = new Map();
  const held = new Map();
  for (let next = 0; next < pending.length; next += 1) {
    const module = pending[next];
    queued.delete(module);
    const result = usesOf(module);
    if (result) {
      results.set(module, result);
      if (!escaped.has(module)) escaped.set(module, new Map());
      addNew(escaped.get(module), escapedNames(module, result));
    }
    // What a module no other module imports exports matters to none.
    if (!importers.has(module)) continue;
    if (!held.has(module)) held.set(module, new Map());
    const whole = wholeHolder(modules, module, exports);
    if (!addNew(held.get(module), heldNames(whole))) continue;
    for (const importer of importers.get(module))
      if (!queued.has(importer)) {
        queued.add(importer);
        pending.push(importer);
      }
  }
  return [...results].flatMap(([module, result]) =>
    result.uses.map((use) => factOf(use, contexts, module)),
  );
};
