import { readSlice, tokens } from "./store.mjs";

const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

// Never spread graph metadata into a preview response. A legacy store has no
// measured token counts until its next ordinary reindex.
export function graphAggregates(meta = {}) {
  return {
    indexed_nodes: count(meta?.nodes),
    indexed_edges: count(meta?.edges),
    raw_evidence_tokens: count(meta?.raw_evidence_tokens),
    matched_subgraph_nodes: count(meta?.matched_subgraph_nodes),
    sliced_tokens_ready: count(meta?.sliced_tokens_ready),
  };
}

// The sample is chosen at build time and never depends on a later locked query.
export function referenceCounts(db, meta, bounded) {
  const empty = { matched_subgraph_nodes: null, sliced_tokens_ready: null };
  if (
    !bounded ||
    typeof meta.evidence_id !== "string" ||
    meta.evidence_id.length > 512
  )
    return empty;
  const row = db
    .prepare("SELECT id FROM nodes ORDER BY id COLLATE BINARY LIMIT 1")
    .get();
  if (!row) return empty;
  const options = { direction: "both", hops: 1, budget: 750 };
  try {
    const sample = readSlice(db, meta, row.id, options);
    const size = tokens(JSON.stringify(sample));
    if (size > options.budget) return empty;
    return {
      matched_subgraph_nodes: sample.nodes.length,
      sliced_tokens_ready: size,
    };
  } catch (error) {
    if (error.message === "Budget too small for root identity and provenance")
      return empty;
    throw error;
  }
}
