// Shared projection helpers. Every fact keeps REA's location, evidence state
// and artifact digest so a report line can cite it.

export const firstObservation = (node) => node.observations?.[0] ?? null;

/**
 * The first of a node's observations `test` accepts, or null. REA merges
 * several observations into one node in no fixed order, so a node's first
 * observation need not be the one a fact is read from.
 */
export const observationWhere = (node, test) =>
  node.observations?.find(test) ?? null;

const locationOf = (evidence) => {
  const value = evidence?.location?.available ? evidence.location.value : null;
  if (value?.kind === "source-range")
    return {
      file: value.source,
      line: value.start?.line ?? null,
      column: value.start?.column ?? null,
    };
  if (value?.kind === "artifact-path")
    return { file: value.path, line: null, column: null };
  return null;
};

export const provenance = (evidence) => ({
  location: locationOf(evidence),
  state: evidence?.state ?? "unknown",
  authority: evidence?.authority ?? "unknown",
  confidence: evidence?.confidence ?? "unknown",
  artifact_sha256: evidence?.artifact?.sha256 ?? null,
});

/** A fact from one observation of an application-graph node. */
export const observationFact = (node, observation, key, data) => ({
  key,
  label: observation?.label ?? key,
  node_id: node.node_id,
  ...provenance(observation?.evidence),
  data,
});

/** A fact from a node's first observation. */
export const graphFact = (node, key, data) =>
  observationFact(node, firstObservation(node), key, data);

/** A fact from an application-graph edge. */
export const edgeFact = (edge, key, data) => ({
  key,
  label: key,
  node_id: edge.edge_id ?? `${edge.source_node_id}->${edge.target_node_id}`,
  ...provenance(edge.evidence),
  data,
});

/** A fact from a semantic-graph node, whose provenance lives in a shared context. */
export const semanticFact = (node, contexts, key, data) => {
  const context = contexts.get(node.evidence?.context_id) ?? {};
  return {
    key,
    label: node.label ?? key,
    node_id: node.node_id,
    ...provenance({ ...context, location: node.evidence?.location }),
    data,
  };
};
