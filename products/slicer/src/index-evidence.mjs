// Turns one REA `analyze_javascript_application` Evidence record into a
// compact local index: the semantic graph's nodes and relations stripped to
// what an agent needs to reason and to locate a line, an adjacency map, a
// lexical index from word to node, and a short surface summary of what the
// whole Evidence is about. The index keeps REA's node ids and source
// locations, so every slice drawn from it still points at the Evidence it
// came from; it does not keep the Evidence's bytes, which is where its size
// goes.

// Properties worth keeping on a compact node, by the kind that carries them.
// Everything else REA puts in `properties` is dropped from the index; the
// full Evidence still has it under the node's id.
const KEPT_PROPERTIES = [
  "value",
  "key",
  "source_kind",
  "command",
  "method",
  "name",
  "url",
  "host",
  "specifier",
  "channel",
  "argv_count",
];

const roleKeyOf = (node) => node.identity?.role_key ?? null;
const moduleOf = (node) => node.identity?.module_path ?? null;
const lineOf = (node) => node.identity?.source_range?.start?.line ?? null;
const columnOf = (node) => node.identity?.source_range?.start?.column ?? null;

// The properties of a node that the index keeps, small enough to inline.
const compactProperties = (properties) => {
  const kept = {};
  for (const name of KEPT_PROPERTIES)
    if (properties?.[name] !== undefined && properties[name] !== null)
      kept[name] = properties[name];
  return kept;
};

// One node as the index stores it: REA's id and kind, where it is, its
// label, the function that owns it, and the few properties above. The id is
// REA's own, so a slice can be matched back to the Evidence.
export const compactNode = (node) => ({
  id: node.node_id,
  kind: node.kind,
  module: moduleOf(node),
  line: lineOf(node),
  column: columnOf(node),
  label: node.label ?? null,
  fn: node.function_node_id ?? null,
  properties: compactProperties(node.properties),
  role: roleKeyOf(node),
});

// One relation as the index stores it: its endpoints, kind and resolution.
export const compactRelation = (relation) => ({
  source: relation.source_node_id,
  target: relation.target_node_id,
  relation: relation.relation,
  resolution: relation.resolution,
});

const WORD = /[A-Za-z0-9_$]{2,}/g;
const MAX_LEXICON_IDS = 2000;

// The words a node is found by: its label, its module path, and the string
// properties it carries (a literal's value, a config key, a command, a
// host). Each is split into words, and the whole string is kept too so a
// path or a host can be searched as one phrase.
const termsOf = (node) => {
  const strings = [
    node.label,
    node.module,
    ...Object.values(node.properties).filter(
      (value) => typeof value === "string",
    ),
  ].filter(Boolean);
  const terms = new Set();
  for (const text of strings) {
    const lower = text.toLowerCase();
    if (lower.length <= 120) terms.add(lower);
    for (const word of lower.match(WORD) ?? []) terms.add(word);
  }
  return terms;
};

// The lexical index: each word maps to the ids of the nodes it is found in,
// sorted and bounded so one very common word cannot bloat the index.
const buildLexicon = (nodes) => {
  const lexicon = new Map();
  for (const node of nodes)
    for (const term of termsOf(node)) {
      if (!lexicon.has(term)) lexicon.set(term, []);
      const ids = lexicon.get(term);
      if (ids.length < MAX_LEXICON_IDS) ids.push(node.id);
    }
  return Object.fromEntries(
    [...lexicon].map(([term, ids]) => [term, [...ids].sort()]),
  );
};

// The host of a URL literal, for the surface summary; null when the value is
// not a URL Release Watch would resolve.
const hostOf = (value) => {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
};

const MAX_SURFACE = 40;
const bounded = (items) => ({
  items: items.slice(0, MAX_SURFACE),
  more: Math.max(0, items.length - MAX_SURFACE),
});

// A short, bounded account of what the whole Evidence is about: how many
// nodes of each kind and in each module, and the notable ones a reviewer
// looks for first — requests and their hosts, process executions and their
// commands, files read from configuration, and the string literals. Each
// entry keeps its node id, so the agent can ask for that node's slice next.
const surfaceOf = (nodes) => {
  const byKind = {};
  const byModule = {};
  for (const node of nodes) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    if (node.module) byModule[node.module] = (byModule[node.module] ?? 0) + 1;
  }
  const at = (node) => ({
    id: node.id,
    module: node.module,
    line: node.line,
    label: node.label,
  });
  const processes = nodes
    .filter((node) => node.kind === "child-process")
    .map((node) => ({ ...at(node), command: node.properties.command ?? null }));
  const requests = nodes
    .filter((node) => node.kind === "request" || node.kind === "endpoint")
    .map((node) => ({
      ...at(node),
      host: node.properties.host ?? hostOf(node.properties.url ?? "") ?? null,
    }));
  const configReads = nodes
    .filter((node) => node.kind === "config-source")
    .map((node) => ({
      ...at(node),
      key: node.properties.key ?? null,
      source: node.properties.source_kind ?? null,
    }));
  const literals = nodes
    .filter((node) => node.kind === "literal")
    .map((node) => ({ ...at(node), value: node.properties.value ?? null }));
  return {
    counts: { nodes: nodes.length, by_kind: byKind },
    modules: Object.entries(byModule)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SURFACE)
      .map(([module, count]) => ({ module, nodes: count })),
    processes: bounded(processes),
    requests: bounded(requests),
    config_reads: bounded(configReads),
    literals: bounded(literals),
  };
};

/**
 * Builds the index of one Evidence record: `{ meta, nodes, edges, lexicon,
 * surface }`. Throws when the record is not an
 * `analyze_javascript_application` Evidence with a semantic graph. `meta`
 * names the subject, the operation and the counts; the Evidence's own bytes
 * are not kept.
 */
export const indexEvidence = (evidence) => {
  const result = evidence?.normalized_result;
  const graph = result?.semantic_graph;
  if (
    evidence?.operation !== "analyze_javascript_application" ||
    !Array.isArray(graph?.nodes) ||
    !Array.isArray(graph?.relations)
  )
    throw new Error(
      "not an analyze_javascript_application Evidence with a semantic graph",
    );
  const nodes = graph.nodes.map(compactNode);
  const edges = graph.relations.map(compactRelation);
  return {
    meta: {
      schema: 1,
      evidence_id: evidence.evidence_id ?? null,
      subject: {
        name: evidence.subject?.name ?? null,
        sha256: evidence.subject?.digest?.sha256 ?? null,
      },
      operation: evidence.operation,
      coverage: graph.coverage?.status ?? null,
      counts: { nodes: nodes.length, edges: edges.length },
    },
    nodes,
    edges,
    lexicon: buildLexicon(nodes),
    surface: surfaceOf(nodes),
  };
};
