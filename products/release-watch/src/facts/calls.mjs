// The call graph REA resolved within modules: which functions bindings hold
// and which call sites call which functions. Ranges only; no source is read.

const rangeOf = (node) => node?.identity?.source_range ?? null;
const moduleOf = (node) => node?.identity?.module_path ?? null;

/**
 * `{ callables, callEdges }` from one semantic graph. A callable is a
 * binding REA links to the function it holds (a declaration or an assigned
 * arrow function), with that function's whole range. A call edge is a call
 * site REA resolved to a function.
 */
export const callGraph = (semantic) => {
  if (!semantic) return { callables: [], callEdges: [] };
  const byId = new Map(semantic.nodes.map((node) => [node.node_id, node]));
  const callables = semantic.nodes
    .filter(
      (node) =>
        node.kind === "binding" &&
        node.label &&
        rangeOf(byId.get(node.function_node_id)),
    )
    .map((node) => ({
      module: moduleOf(node),
      name: node.label,
      range: rangeOf(byId.get(node.function_node_id)),
    }));
  const callEdges = semantic.relations
    .filter((relation) => relation.relation === "calls")
    .map((relation) => [
      byId.get(relation.source_node_id),
      byId.get(relation.target_node_id),
    ])
    .filter(
      ([source, target]) =>
        source?.kind === "call-site" &&
        target?.kind === "function" &&
        rangeOf(source) &&
        rangeOf(target),
    )
    .map(([source, target]) => ({
      module: moduleOf(source),
      range: rangeOf(source),
      target: { module: moduleOf(target), range: rangeOf(target) },
    }));
  return { callables, callEdges };
};
