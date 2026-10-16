// The object property each literal is the value of (`ENDPOINTS.telemetry`),
// from REA's semantic graph: the property slot the literal defines, and the
// binding whose initializer writes that slot, directly or through the slots
// that hold it (`CONFIG.api.base`). Node ids and labels only; no source is
// read.

/**
 * A Map from each literal node that defines a property slot to
 * `{ binding, path }`: the label of the binding that holds the slot and
 * REA's property path below it. A slot REA reports no writing binding for
 * (a default-exported object) is left out.
 */
export const definedProperties = (semantic) => {
  const byId = new Map(semantic.nodes.map((node) => [node.node_id, node]));
  const writer = new Map();
  const defined = [];
  for (const relation of semantic.relations) {
    if (relation.relation === "writes-property")
      writer.set(relation.target_node_id, relation.source_node_id);
    else if (
      relation.relation === "defines" &&
      byId.get(relation.target_node_id)?.kind === "property-slot"
    )
      defined.push(relation);
  }
  const holder = (slot) => {
    const seen = new Set();
    let id = slot;
    while (byId.get(id)?.kind === "property-slot" && !seen.has(id)) {
      seen.add(id);
      id = writer.get(id);
    }
    const node = byId.get(id);
    return node?.kind === "binding" && node.label ? node.label : null;
  };
  const found = new Map();
  for (const relation of defined) {
    const binding = holder(relation.target_node_id);
    const path = byId.get(relation.target_node_id).properties?.property_path;
    if (binding && Array.isArray(path) && path.length > 0)
      found.set(relation.source_node_id, { binding, path });
  }
  return found;
};
