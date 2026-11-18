// The queries an agent runs against a built index, each returning the
// smallest answer that still carries provenance. A search returns matching
// nodes with their locations; a slice returns the neighbourhood of one node
// out to a few hops, trimmed to a token budget; the summary returns the
// surface. Every node keeps REA's id and source location, so a caller can
// read the lines or ask REA for that node's full Evidence.
import { estimateJsonTokens } from "./tokens.mjs";

// The location an agent needs to find a node: its module and line.
const placeOf = (node) =>
  node.module === null
    ? null
    : `${node.module}${node.line === null ? "" : `:${node.line}`}`;

// One node as a search or slice returns it: id, kind, where, label and the
// kept properties, without the index's internal role key.
const viewNode = (node) => ({
  id: node.id,
  kind: node.kind,
  at: placeOf(node),
  label: node.label,
  ...(Object.keys(node.properties).length > 0
    ? { properties: node.properties }
    : {}),
});

const WORD = /[A-Za-z0-9_$]{2,}/g;

/**
 * The nodes that match `query`: every node the lexicon lists for a whole
 * word of the query, then, when the query is a phrase the lexicon does not
 * hold, every node whose label or kept string property contains it. Returns
 * `{ query, matches, total }`, `matches` bounded by `limit`.
 */
export const search = (index, query, { limit = 20 } = {}) => {
  const lower = String(query).toLowerCase();
  const ids = new Set();
  if (index.lexicon[lower]) for (const id of index.lexicon[lower]) ids.add(id);
  for (const word of lower.match(WORD) ?? [])
    for (const id of index.lexicon[word] ?? []) ids.add(id);
  // A phrase the lexicon does not hold whole (a path fragment, part of a
  // host): fall back to a scan of the kept strings.
  if (ids.size === 0 && lower.length >= 2)
    for (const node of index.nodes.values())
      if (
        [node.label, node.module, ...Object.values(node.properties)]
          .filter((value) => typeof value === "string")
          .some((value) => value.toLowerCase().includes(lower))
      )
        ids.add(node.id);
  const all = [...ids].map((id) => index.nodes.get(id)).filter(Boolean);
  return {
    query,
    total: all.length,
    matches: all.slice(0, limit).map(viewNode),
  };
};

// The edges that touch `id`, as lines a reader follows: the node at the
// other end, the relation and its direction.
const edgeViews = (index, id) => {
  const sides = index.adjacency.get(id) ?? { out: [], in: [] };
  return [
    ...sides.out.map((edge) => ({
      relation: edge.relation,
      direction: "to",
      node: edge.target,
      resolution: edge.resolution,
    })),
    ...sides.in.map((edge) => ({
      relation: edge.relation,
      direction: "from",
      node: edge.source,
      resolution: edge.resolution,
    })),
  ];
};

const neighbourIds = (index, id) =>
  (index.adjacency.get(id) ?? { out: [], in: [] }).out
    .map((edge) => edge.target)
    .concat(
      (index.adjacency.get(id) ?? { out: [], in: [] }).in.map(
        (edge) => edge.source,
      ),
    );

/**
 * The slice around the node `id`: that node and the nodes reachable within
 * `hops` edges in either direction, with the edges among them, trimmed so
 * the result's estimated token cost stays under `budget`. Returns `{ root,
 * nodes, edges, hops, reached, omitted, estimated_tokens, truncated }`, or
 * `{ error }` when no node has that id. Nodes are added nearest first, so a
 * budget keeps the closest neighbourhood.
 */
export const slice = (index, id, { hops = 2, budget = 1500 } = {}) => {
  const root = index.nodes.get(id);
  if (!root) return { error: `no node has the id ${id}` };
  // Breadth-first from the root, recording each node's distance.
  const distance = new Map([[id, 0]]);
  const order = [id];
  for (let cursor = 0; cursor < order.length; cursor += 1) {
    const current = order[cursor];
    const depth = distance.get(current);
    if (depth >= hops) continue;
    for (const next of neighbourIds(index, current))
      if (!distance.has(next) && index.nodes.has(next)) {
        distance.set(next, depth + 1);
        order.push(next);
      }
  }
  // Add nodes nearest first until the nodes' own estimated tokens would pass
  // `budget`; the root always fits. The budget governs the node payload, the
  // bulk of a slice; the whole answer, measured below, adds the edges among
  // the kept nodes and a small envelope on top.
  const kept = [];
  const keptSet = new Set();
  let reached = false;
  let nodesTokens = 0;
  for (const nodeId of order) {
    const view = [...kept, nodeId].map((each) =>
      viewNode(index.nodes.get(each)),
    );
    const cost = estimateJsonTokens(view);
    if (kept.length > 0 && cost > budget) {
      reached = true;
      break;
    }
    kept.push(nodeId);
    keptSet.add(nodeId);
    nodesTokens = cost;
  }
  const edges = index.edges
    .filter((edge) => keptSet.has(edge.source) && keptSet.has(edge.target))
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      resolution: edge.resolution,
    }));
  const nodes = kept.map((nodeId) => {
    const node = index.nodes.get(nodeId);
    return { ...viewNode(node), hops: distance.get(nodeId) };
  });
  const answer = {
    root: { ...viewNode(root), edges: edgeViews(index, id).length },
    hops,
    reached: order.length,
    nodes,
    edges,
    omitted: order.length - kept.length,
    truncated: reached,
    nodes_tokens: nodesTokens,
  };
  return { ...answer, estimated_tokens: estimateJsonTokens(answer) };
};

/** The surface summary of the whole index, as the index built it. */
export const summary = (index) => ({
  subject: index.meta.subject,
  coverage: index.meta.coverage,
  counts: index.meta.counts,
  ...index.surface,
});
