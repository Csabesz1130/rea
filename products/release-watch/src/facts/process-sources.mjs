// Where a module's child_process values come from: the seeds that
// process-flow.mjs follows. A seed is a site and the holder it creates,
// either a binding (an import that binds a name) or a value (a call whose
// result holds child_process):
// - its child_process imports, and `require`/`import` calls that bind no name;
// - imports of a local module's exports that hold child_process
//   (process-exports.mjs);
// - a `require(name)` REA resolved to no module whose argument REA reports
//   constant "child_process";
// - as Release Watch's correlation, a load REA resolved to no module, or a
//   call of a require function REA does not resolve (`module.require`,
//   `process.mainModule.require`, a function createRequire returns,
//   `eval("require")`, a binding that holds `require`), which counts only
//   through a read of a child_process export on what it loads.
import { isNodeModule, isProcessModule } from "../catalog.mjs";
import { sameStart, within } from "../ranges.mjs";
import { exportHolder, wholeHolder } from "./process-exports.mjs";
import {
  calleeOf,
  callOf,
  definedBefore,
  rangeOf,
  relationsOf,
  sameRange,
} from "./process-graph.mjs";

// What an import of the whole module binds; anything else is one export.
const WHOLE_MODULE = new Set(["*", "default", null]);
const ELLIPSIS = "…";

const overlaps = (a, b) =>
  a !== null && b !== null && (within(a, b) || within(b, a));

/** The child_process import edges of a module's import index entry. */
export const processSites = (entry) =>
  (entry?.externalSites ?? []).filter((site) =>
    isProcessModule(site.data.specifier),
  );

// Import edges that bind no name, once per range, apart from the ones a
// binding import covers (CommonJS reports `require(...)` inside its
// declaration as a second edge) and side-effect `import "child_process"`.
const valueSites = (sites) => {
  const named = sites.filter((site) => site.data.local !== null);
  const seen = new Set();
  return sites.filter((site) => {
    if (site.data.local !== null || site.data.form === "static-import")
      return false;
    if (named.some((other) => overlaps(other.data.range, site.data.range)))
      return false;
    const key = JSON.stringify(site.data.range);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const loadName = (site, specifier) =>
  `${site.data.form === "dynamic-import" ? "import" : "require"}(${JSON.stringify(specifier)})`;

const externalSeeds = (entry) => {
  const sites = processSites(entry);
  return [
    ...sites
      .filter((site) => site.data.local !== null)
      .map((site) => ({
        site,
        binding: true,
        holder: {
          name: site.data.local,
          member: WHOLE_MODULE.has(site.data.imported)
            ? null
            : site.data.imported,
          via: "import",
          from: null,
          heuristic: false,
        },
      })),
    ...valueSites(sites).map((site) => ({
      site,
      binding: false,
      holder: {
        name: loadName(site, site.data.specifier),
        member: null,
        via: "require",
        from: null,
        heuristic: false,
      },
    })),
  ];
};

// What a local import holds: one export, or the whole module.
const localHolder = (modules, site, exports) => {
  const { module, imported, form } = site.data;
  if (imported === "default")
    return exportHolder(modules, module, "default", exports);
  return imported === null || imported === "*" || form === "dynamic-import"
    ? wholeHolder(modules, module, exports)
    : exportHolder(modules, module, imported, exports);
};

const NO_CORRELATION = { named: () => null, namedList: () => [] };

/**
 * True when a local import edge may hold child_process: REA traces what it
 * imports to child_process, or it imports from `direct`, a module that uses
 * child_process (whose bindings Release Watch may correlate).
 */
export const mayImportProcess = (modules, site, direct) =>
  direct.has(site.data.module) ||
  localHolder(modules, site, NO_CORRELATION) !== null;

// A heuristic holder names the module whose binding holds it; any other,
// the module imported from.
const exportedSeed = (site, holder, name, binding) => ({
  site,
  binding,
  holder: {
    name,
    member: holder.member,
    namespace: holder.namespace ?? null,
    via: holder.heuristic ? "export-name" : "export",
    from: holder.heuristic ? holder.module : site.data.module,
    exported: holder.name,
    heuristic: holder.heuristic,
  },
});

const localSeeds = (modules, entry, exports) => {
  const sites = entry?.localSites ?? [];
  const seeds = [];
  for (const site of sites.filter((item) => item.data.local !== null)) {
    const holder = localHolder(modules, site, exports);
    if (holder) seeds.push(exportedSeed(site, holder, site.data.local, true));
  }
  for (const site of valueSites(sites)) {
    const holder = wholeHolder(modules, site.data.module, exports);
    if (holder)
      seeds.push(
        exportedSeed(
          site,
          holder,
          loadName(site, site.data.specifier ?? site.data.module),
          false,
        ),
      );
  }
  return seeds;
};

const loaderHolder = (name) => ({
  name,
  member: null,
  via: "loader",
  from: null,
  heuristic: true,
  loader: name,
});

// The constant REA reports for the one binding whose read is the first
// argument of `call`, or undefined.
const constantArgument = (graph, index, call) => {
  const callRange = rangeOf(call);
  const first = index.arguments.find(
    (node) =>
      within(rangeOf(node), callRange) &&
      (node.identity?.role_key ?? "").endsWith(":0"),
  );
  const sources = first ? (graph.aliasedFrom.get(first.node_id) ?? []) : [];
  const binding =
    sources.length === 1 ? graph.readBinding.get(sources[0].node_id) : null;
  return binding
    ? { binding, value: graph.literals.get(binding.node_id) }
    : undefined;
};

// `require(name)` and the like: REA resolved the load to no module.
const unresolvedSeeds = (graph, index, entry) =>
  (entry?.unresolvedSites ?? []).flatMap((site) => {
    const call = index.calls.find(
      (node) => site.data.range && sameRange(rangeOf(node), site.data.range),
    );
    if (!call) return [];
    const name = site.data.expression ?? "require(…)";
    const constant = constantArgument(graph, index, call);
    // A constant REA reports for another module is not child_process.
    if (typeof constant?.value === "string" && !isProcessModule(constant.value))
      return [];
    const holder = isProcessModule(constant?.value)
      ? {
          name,
          member: null,
          via: "constant",
          from: constant.binding.label ?? null,
          heuristic: false,
        }
      : loaderHolder(name);
    return [{ site, call, binding: false, holder }];
  });

const isGlobalRead = (graph, node, label) =>
  node?.kind === "expression" &&
  node.label === label &&
  !node.properties?.operation_kind &&
  !graph.readBinding.has(node.node_id);

const startKey = (range) => `${range.start.line}:${range.start.column}`;

/** Where the loads REA reports in a module (`require("x")` and the like) start. */
export const loadStarts = (entry) =>
  new Set(
    [
      ...(entry?.externalSites ?? []),
      ...(entry?.localSites ?? []),
      ...(entry?.unresolvedSites ?? []),
    ]
      .map((site) => site.data.range)
      .filter(Boolean)
      .map(startKey),
  );

/**
 * True for a reference to `require` that no load REA reports starts at:
 * `require` used as a value (`const load = require`, `typeof require`),
 * not called as `require("x")`. The reference may still be a local binding
 * named `require`; callers that need the global check REA's reads.
 */
export const isRequireValue = (node, starts) =>
  node.kind === "expression" &&
  node.label === "require" &&
  !node.properties?.operation_kind &&
  node.identity?.source_range != null &&
  !starts.has(startKey(node.identity.source_range));

// The bindings REA's data flow shows a read of `require` reaching: one it
// is assigned to, or one assigned a call that returns it (esbuild's `var
// __require = ((x) => typeof require !== "undefined" ? require : x)(…)`).
const requireHolders = (graph, read) =>
  relationsOf(graph, read, "aliases").flatMap(({ target }) => {
    if (target.kind === "binding") return [target];
    if (target.kind !== "return-site") return [];
    return relationsOf(graph, target, "returns-to-call").flatMap(
      ({ target: call }) =>
        relationsOf(graph, call, "aliases")
          .map(({ target: binding }) => binding)
          .filter((binding) => binding.kind === "binding"),
    );
  });

// The bindings and calls that hold a require function REA does not resolve:
// a binding REA's data flow shows the global `require` reaching, a binding
// defined right before a read of it (`const load = require`, Release
// Watch's correlation, as for child_process values), and the bindings and
// calls that hold a function createRequire made.
const requireFunctions = (graph, index, entry, importBinding) => {
  const bindings = new Set();
  const calls = new Set();
  const starts = loadStarts(entry);
  for (const read of index.nodes) {
    if (!isRequireValue(read, starts) || !isGlobalRead(graph, read, "require"))
      continue;
    for (const binding of [
      ...requireHolders(graph, read),
      ...definedBefore(graph, index, rangeOf(read), null),
    ])
      bindings.add(binding.node_id);
  }
  for (const site of entry?.externalSites ?? []) {
    if (!isNodeModule(site.data.specifier)) continue;
    if (site.data.imported !== "createRequire" || site.data.local === null)
      continue;
    const binding = importBinding(index, site);
    for (const { target: read } of binding
      ? relationsOf(graph, binding, "reads")
      : []) {
      const call = callOf(index, rangeOf(read));
      if (!call) continue;
      calls.add(call.node_id);
      for (const { target } of relationsOf(graph, call, "aliases"))
        if (target.kind === "binding") bindings.add(target.node_id);
    }
  }
  return { bindings, calls };
};

// What a call loads through, when its callee is a require function REA does
// not resolve; null otherwise.
const loaderName = (graph, index, call, makers) => {
  const callee = calleeOf(index, call);
  if (!callee) return null;
  const path = callee.properties?.property_path;
  if (
    callee.properties?.operation_kind === "read" &&
    path?.at(-1) === "require"
  ) {
    // The receiver: the reference REA reports where the member read starts.
    const base = index.nodes.find(
      (node) =>
        node.kind === "expression" &&
        !node.properties?.operation_kind &&
        sameStart(rangeOf(node), rangeOf(callee)) &&
        within(rangeOf(node), rangeOf(callee)),
    );
    return `${base?.label ?? ELLIPSIS}.${path.join(".")}(${ELLIPSIS})`;
  }
  if (makers.bindings.has(graph.readBinding.get(callee.node_id)?.node_id))
    return `${callee.label}(${ELLIPSIS})`;
  if (callee.kind !== "call-site") return null;
  if (makers.calls.has(callee.node_id))
    return `createRequire(${ELLIPSIS})(${ELLIPSIS})`;
  return isGlobalRead(graph, calleeOf(index, callee), "eval")
    ? `eval(${ELLIPSIS})(${ELLIPSIS})`
    : null;
};

const loaderSeeds = (graph, index, entry, { importBinding, taken }) => {
  const makers = requireFunctions(graph, index, entry, importBinding);
  return index.calls.flatMap((call) => {
    if (taken.some((range) => sameRange(range, rangeOf(call)))) return [];
    const name = loaderName(graph, index, call, makers);
    return name
      ? [{ site: null, call, binding: false, holder: loaderHolder(name) }]
      : [];
  });
};

/**
 * The seeds of one module: `{ site, binding, holder, call? }`. `exports`
 * resolves local imports (`named`, `namedList`); `importBinding` finds the
 * binding an import edge creates; `loaders` is set for a module that may
 * call a require function REA does not resolve.
 */
export const seedsOf = ({
  modules,
  graph,
  index,
  entry,
  exports,
  importBinding,
  loaders,
}) => {
  const sites = [
    ...externalSeeds(entry),
    ...localSeeds(modules, entry, exports),
  ];
  const unresolved = unresolvedSeeds(graph, index, entry);
  const taken = [
    ...(entry?.externalSites ?? []),
    ...(entry?.localSites ?? []),
    ...(entry?.unresolvedSites ?? []),
  ]
    .map((site) => site.data.range)
    .filter(Boolean);
  return [
    ...sites,
    ...unresolved,
    ...(loaders
      ? loaderSeeds(graph, index, entry, { importBinding, taken })
      : []),
  ];
};
