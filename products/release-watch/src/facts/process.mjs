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
import { processGraph, rangeOf } from "./process-graph.mjs";
import { mayImportProcess, processSites, seedsOf } from "./process-sources.mjs";
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
// resolve: a member read named `require`, a read of `eval`, an import of
// createRequire, or a load REA resolved to no module.
const loaderModules = (semantic, modules) => {
  const found = new Set();
  for (const node of semantic.nodes) {
    const path = node.properties?.property_path;
    if (path?.at(-1) === "require" || node.label === "eval")
      found.add(node.identity?.module_path ?? null);
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

// Where a module's top-level bindings that hold child_process go where
// REA's graph does not show: the names an importer may find them under
// when REA traced no export (Release Watch's correlation).
const escapedNames = (module, result) => {
  const names = new Map();
  for (const use of result.uses)
    if (use.kind === "value" && use.holder.node?.kind === "binding")
      if (!use.holder.node.function_node_id && !use.holder.namespace)
        names.set(use.holder.name, {
          member: use.holder.member,
          module,
          name: use.holder.name,
          site: null,
          commonjs: false,
          heuristic: true,
        });
  return names;
};

/**
 * Process gaps of one semantic graph: every place a module uses a value
 * REA ties to child_process and REA reported no process site for it.
 * `modules` is the import index and `childProcesses` the process sites
 * already projected from the graph; a module without semantic facts is
 * left to the coverage rules that report it unexamined.
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
  // A module that imports a local module may hold what it exports.
  const wanted = new Set(direct);
  for (const [module, entry] of modules)
    if (
      entry.localSites.some((site) => mayImportProcess(modules, site, direct))
    )
      wanted.add(module);
  const graph = processGraph(semantic, wanted, childProcesses);
  const escaped = new Map();
  const exports = {
    named: (module, name) => escaped.get(module)?.get(name) ?? null,
    namedList: (module) => [...(escaped.get(module)?.keys() ?? [])],
  };
  const usesOf = (module) => {
    const index = graph.modules.get(module);
    if (!index) return null;
    const entry = modules.get(module);
    const seeds = seedsOf({
      modules,
      graph,
      index,
      entry,
      exports,
      importBinding,
      loaders: loaders.has(module),
    });
    return moduleUses(graph, index, seeds, importBinding);
  };
  // Modules that use child_process first, so that the names their bindings
  // escape under are known to the modules importing them.
  const results = new Map();
  for (const module of direct) {
    const result = usesOf(module);
    if (!result) continue;
    results.set(module, result);
    escaped.set(module, escapedNames(module, result));
  }
  // The rest, and a module again when it imports names correlated above.
  const correlated = (module) =>
    (modules.get(module)?.localSites ?? []).some(
      (site) => escaped.get(site.data.module)?.size > 0,
    );
  for (const module of wanted) {
    if (results.has(module) && !correlated(module)) continue;
    const result = usesOf(module);
    if (result) results.set(module, result);
  }
  return [...results].flatMap(([module, result]) =>
    result.uses.map((use) => factOf(use, contexts, module)),
  );
};
