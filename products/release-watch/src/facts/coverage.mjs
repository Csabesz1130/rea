// REA's coverage of an application analysis as Release Watch reports it:
// truncation, node ceilings and the files they left partly or wholly
// unexamined. Derived from REA's own limits and retained nodes.
import { isScriptPath } from "./modules.mjs";

// Modules whose semantic node count reached REA's per-file ceiling: where a
// truncated graph dropped facts. Derived from REA's own limit and nodes.
const ceilingModules = (semantic) => {
  const ceiling = semantic?.coverage?.limits?.find(
    (limit) => limit.name === "semantic_graph_file_node_ceiling",
  )?.value;
  if (!semantic?.coverage?.truncated || !ceiling) return [];
  const counts = new Map();
  for (const node of semantic.nodes) {
    const modulePath = node.identity?.module_path;
    if (modulePath) counts.set(modulePath, (counts.get(modulePath) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count >= ceiling)
    .map(([modulePath]) => modulePath)
    .sort();
};

// Whether the semantic graph reached REA's global node ceiling. REA builds
// files in interleaved steps, so the retained nodes do not say which files
// it cut short: any analyzed file may be partial then.
const globalLimitReached = (semantic) => {
  const ceiling = semantic?.coverage?.limits?.find(
    (limit) => limit.name === "semantic_graph_node_ceiling",
  )?.value;
  return Boolean(
    semantic?.coverage?.truncated &&
    ceiling &&
    semantic.nodes.length >= ceiling,
  );
};

/** REA's coverage of both graphs, as Release Watch reports it. */
export const coverageOf = (graph, semantic) => ({
  graph: graph.coverage?.status ?? "unknown",
  graph_truncated: graph.coverage?.truncated === true,
  graph_omitted: graph.coverage?.omitted_count ?? 0,
  semantic: semantic?.coverage?.status ?? "unavailable",
  semantic_truncated: semantic?.coverage?.truncated === true,
  semantic_omitted_nodes: semantic?.coverage?.omitted_nodes ?? null,
  semantic_limits: (semantic?.coverage?.limits ?? []).map(
    (limit) =>
      `${limit.name} ${limit.value}${limit.unit === "items" ? "" : ` ${limit.unit}`}`,
  ),
  semantic_ceiling_modules: ceilingModules(semantic),
  semantic_global_limit_reached: globalLimitReached(semantic),
});

// Script files with no semantic node at all when REA truncated the semantic
// graph: the global ceiling left them unexamined.
export const unreachedModules = (semantic, assets) => {
  if (!semantic?.coverage?.truncated) return [];
  const reached = new Set(
    semantic.nodes.map((node) => node.identity?.module_path).filter(Boolean),
  );
  return assets
    .map((asset) => asset.key)
    .filter((key) => isScriptPath(key) && !reached.has(key))
    .sort();
};

/**
 * The script files of one analyzed app REA examined only in part or not at
 * all: those at the per-file node ceiling, those the global limit left
 * unreached, every script file once the global limit is reached (REA does
 * not say which files it cut short), and files REA could not analyze.
 */
export const examinedInPart = (app) => [
  ...app.coverage.semantic_ceiling_modules,
  ...(app.coverage.semantic_unreached_modules ?? []),
  ...(app.coverage.semantic_global_limit_reached
    ? app.assets.map((asset) => asset.key).filter(isScriptPath)
    : []),
  ...app.analysisFailures
    .map((failure) => failure.location?.file)
    .filter(Boolean),
];

/**
 * A test for the files of one app whose semantic facts REA may not report
 * in full: those examinedInPart lists, and every file when REA produced no
 * semantic graph. What REA does not report there is unknown, not absent.
 */
export const partlyExamined = (app) => {
  if (!app) return () => false;
  if (app.coverage.semantic === "unavailable") return () => true;
  const files = new Set(examinedInPart(app));
  return (module) => files.has(module);
};
