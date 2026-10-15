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

// The file REA was projecting when the semantic graph reached its global
// node ceiling: REA keeps nodes in projection order, so it is the module of
// the last retained node. Null when the global ceiling was not reached.
const cutModule = (semantic) => {
  const ceiling = semantic?.coverage?.limits?.find(
    (limit) => limit.name === "semantic_graph_node_ceiling",
  )?.value;
  if (!semantic?.coverage?.truncated || !ceiling) return null;
  if (semantic.nodes.length < ceiling) return null;
  for (let index = semantic.nodes.length - 1; index >= 0; index -= 1) {
    const modulePath = semantic.nodes[index].identity?.module_path;
    if (modulePath) return modulePath;
  }
  return null;
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
  semantic_cut_module: cutModule(semantic),
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
