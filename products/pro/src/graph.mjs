import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { visitEvidence } from "./evidence.mjs";

const dbFile = (dir) => join(dir, "rea-graph.sqlite");
const tokenOptions = { disallowedSpecial: new Set() };
export const tokens = (text) => countTokens(text, tokenOptions);
const schema = `
  CREATE TABLE meta (json TEXT NOT NULL);
  CREATE TABLE nodes (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL, norm REAL NOT NULL DEFAULT 0);
  CREATE TABLE edges (src TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
                      dst TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
                      kind TEXT NOT NULL, resolution TEXT NOT NULL, ref TEXT, via TEXT);
  CREATE INDEX outgoing ON edges(src,kind,dst);
  CREATE INDEX incoming ON edges(dst,kind,src);
  CREATE TABLE postings (term TEXT NOT NULL, node INTEGER NOT NULL, tf REAL NOT NULL, PRIMARY KEY(term,node)) WITHOUT ROWID;
  CREATE INDEX node_terms ON postings(node);
  CREATE TABLE terms (term TEXT PRIMARY KEY, idf REAL NOT NULL) WITHOUT ROWID;
`;
const DB_ID = 0x52454150;
function configure(db) {
  db.exec(
    "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000",
  );
}
function owned(db, allowNew) {
  const id = db.prepare("PRAGMA application_id").get().application_id;
  if (
    allowNew &&
    id === 0 &&
    !db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
  )
    return false;
  if (
    id !== DB_ID ||
    db.prepare("PRAGMA user_version").get().user_version !== 1
  )
    throw new Error(
      "Directory does not contain a supported REA Pro graph database",
    );
  return true;
}

function words(value) {
  return (
    value
      .normalize("NFKC")
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}
function frequencies(fields) {
  const terms = new Map();
  for (const [value, weight] of fields) {
    if (typeof value !== "string") continue;
    for (const word of words(value))
      terms.set(word, (terms.get(word) ?? 0) + weight);
  }
  return [...terms].map(([term, n]) => [term, 1 + Math.log(n)]);
}
function requiredString(value, field) {
  if (typeof value !== "string" || !value.length)
    throw new Error(`Invalid graph ${field}`);
  return value;
}

export async function buildGraph(dir, evidence) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = dbFile(dir);
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const db = new DatabaseSync(path);
  try {
    configure(db);
    // A single transaction covers table creation, new postings, metadata and validation.
    // Existing readers see their previous snapshot even when a rebuild fails.
    db.exec("BEGIN IMMEDIATE");
    if (!owned(db, true))
      db.exec(
        `${schema} PRAGMA application_id=${DB_ID}; PRAGMA user_version=1;`,
      );
    else
      db.exec(
        "DELETE FROM edges; DELETE FROM postings; DELETE FROM terms; DELETE FROM nodes; DELETE FROM meta",
      );
    const node = db.prepare("INSERT INTO nodes(id,data) VALUES(?,?)");
    const edge = db.prepare(
      "INSERT INTO edges(src,dst,kind,resolution,ref) VALUES(?,?,?,?,?)",
    );
    const posting = db.prepare("INSERT INTO postings VALUES(?,?,?)");
    let nodes = 0,
      edges = 0;
    const meta = await visitEvidence(
      evidence,
      (item) => {
        requiredString(item.id, "node id");
        requiredString(item.kind, "node kind");
        const { lastInsertRowid } = node.run(item.id, JSON.stringify(item));
        const fields = [
          [item.label, 4],
          [item.kind, 2],
          [item.module, 1],
          ...Object.values(item.properties).map((value) => [value, 1]),
        ];
        for (const [term, tf] of frequencies(fields))
          posting.run(term, lastInsertRowid, tf);
        nodes++;
      },
      (item) => {
        edge.run(
          ...[item.source, item.target, item.relation, item.resolution].map(
            (v) => requiredString(v, "relation"),
          ),
          item.ref ?? null,
        );
        edges++;
      },
    );
    if (meta.operation === "get_call_graph" && meta.direction === "backward")
      db.exec("UPDATE edges SET src=dst, dst=src");
    const ownershipEdges = db
      .prepare(`INSERT INTO edges(src,dst,kind,resolution)
      SELECT owner.id,n.id,'contains','function_node_id' FROM nodes n
      JOIN nodes owner ON owner.id=json_extract(n.data,'$.fn') WHERE owner.id!=n.id`)
      .run().changes;
    // Only a producer-supplied call-site -> function relation can support a function call.
    // Keep its direction, resolution, call-site ID and original Evidence relation ID.
    const functionCalls = db
      .prepare(`INSERT INTO edges(src,dst,kind,resolution,ref,via)
      SELECT owner.id,e.dst,'calls-function',e.resolution,e.ref,e.src FROM edges e
      JOIN nodes site ON site.id=e.src JOIN nodes callee ON callee.id=e.dst
      JOIN nodes owner ON owner.id=json_extract(site.data,'$.fn')
      WHERE e.kind='calls' AND json_extract(site.data,'$.kind')='call-site'
        AND json_extract(callee.data,'$.kind')='function' AND json_extract(owner.data,'$.kind')='function'`)
      .run().changes;
    // Four distinctive terms per endpoint carry vocabulary across one observed edge.
    // Keep twelve context dimensions per node so hubs cannot swamp their own labels.
    const computeIdf = db.prepare(
      "INSERT INTO terms SELECT term, 1+ln((?+1.0)/(COUNT(*)+1.0)) FROM postings GROUP BY term",
    );
    computeIdf.run(nodes);
    db.exec(`CREATE TEMP TABLE anchors AS
      SELECT node, term, tf, idf FROM (
        SELECT p.*, t.idf, row_number() OVER (PARTITION BY node ORDER BY tf*idf DESC,term) AS rank
        FROM postings p JOIN terms t USING(term)
      ) WHERE rank<=4;
      CREATE INDEX anchors_by_node ON anchors(node);
      CREATE TEMP TABLE context AS
      WITH neighbors AS (SELECT src a,dst b FROM edges UNION ALL SELECT dst,src FROM edges),
      candidates AS (
        SELECT dest.rowid AS node, a.term, max(a.tf)*0.32 AS tf, max(a.tf*a.idf) AS priority
        FROM neighbors e JOIN nodes dest ON dest.id=e.a JOIN nodes origin ON origin.id=e.b
        JOIN anchors a ON a.node=origin.rowid WHERE e.a!=e.b GROUP BY dest.rowid,a.term
      )
      SELECT node,term,tf FROM (
        SELECT *,row_number() OVER (PARTITION BY node ORDER BY priority DESC,term) AS rank FROM candidates
      ) WHERE rank<=12;
      INSERT OR IGNORE INTO postings(term,node,tf) SELECT term,node,tf FROM context;
      DELETE FROM terms;`);
    computeIdf.run(nodes);
    db.exec(`UPDATE nodes SET norm=coalesce((SELECT sqrt(sum((p.tf*t.idf)*(p.tf*t.idf)))
      FROM postings p JOIN terms t USING(term) WHERE p.node=nodes.rowid),0)`);
    const stats = {
      ...meta,
      nodes,
      edges: edges + ownershipEdges + functionCalls,
      source_edges: edges,
      ownership_edges: ownershipEdges,
      derived_function_calls: functionCalls,
      vector: "graph-context-tfidf-cosine-v1",
    };
    db.prepare("INSERT INTO meta VALUES(?)").run(JSON.stringify(stats));
    db.exec("COMMIT");
    return stats;
  } finally {
    db.close();
  }
}

function queryGraph(dir, query) {
  const db = new DatabaseSync(dbFile(dir), { readOnly: true });
  try {
    configure(db);
    db.exec("BEGIN");
    owned(db, false);
    return query(
      db,
      JSON.parse(db.prepare("SELECT json FROM meta").get().json),
    );
  } finally {
    db.close();
  }
}
export const graphStats = (dir) => queryGraph(dir, (_, meta) => meta);

const view = (data) => {
  const n = JSON.parse(data);
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    module: n.module,
    line: n.line,
    column: n.column,
    ...(Object.keys(n.properties).length ? { properties: n.properties } : {}),
  };
};
const source = (meta) => ({
  evidence_id: meta.evidence_id,
  coverage: meta.coverage,
  ...(meta.source_truncated ? { source_truncated: true } : {}),
});

export function searchGraph(dir, query, limit, offset = 0, kind) {
  const tf = frequencies([[query, 1]]);
  return queryGraph(dir, (db, meta) => {
    const hits = db
      .prepare(`WITH q AS (
      SELECT t.term, t.idf, json_extract(j.value,'$[1]') * t.idf AS w
      FROM json_each(?) j JOIN terms t ON t.term=json_extract(j.value,'$[0]')
    ), scores AS (
      SELECT p.node, sum(p.tf*q.idf*q.w) AS dot FROM q JOIN postings p USING(term) GROUP BY p.node
    )
    SELECT n.id, n.data, s.dot/(n.norm*(SELECT sqrt(sum(w*w)) FROM q)) AS score
    FROM scores s JOIN nodes n ON n.rowid=s.node WHERE (? IS NULL OR json_extract(n.data,'$.kind')=?) ORDER BY score DESC,n.id LIMIT ? OFFSET ?`)
      .all(JSON.stringify(tf), kind ?? null, kind ?? null, limit + 1, offset);
    const matches = hits.slice(0, limit).map((hit) => {
      const n = view(hit.data);
      const label = typeof n.label === "string" ? n.label.slice(0, 240) : null;
      return {
        id: n.id,
        kind: n.kind,
        module: n.module,
        line: n.line,
        label,
        ...(label !== n.label ? { label_truncated: true } : {}),
        score: Number(hit.score.toFixed(6)),
      };
    });
    return { ...source(meta), matches, more: hits.length > limit };
  });
}

export function sliceGraph(
  dir,
  id,
  { hops, direction, budget, relation, evidence_id },
) {
  return queryGraph(dir, (db, meta) => {
    if (evidence_id !== undefined && evidence_id !== meta.evidence_id)
      throw new Error(
        "Graph Evidence changed. Repeat the search against the current index",
      );
    const get = db.prepare("SELECT data FROM nodes WHERE id=?");
    const row = get.get(id);
    if (!row) throw new Error("Unknown graph node");
    const root = view(row.data);
    const result = {
      ...source(meta),
      tokenizer: "cl100k_base",
      nodes: [root],
      edges: [],
      truncated: false,
    };
    const fits = () => tokens(JSON.stringify(result)) <= budget;
    if (!fits()) {
      result.nodes[0] = { id: root.id, kind: root.kind, details_omitted: true };
      result.truncated = true;
      if (!fits())
        throw new Error("Budget too small for root identity and provenance");
    }
    const filters = relation === undefined ? "" : " AND kind=:relation";
    const side = (col) =>
      `SELECT rowid,src,dst,kind,resolution,ref,via FROM edges WHERE ${col}=:id${filters}`;
    const sides =
      direction === "out"
        ? [side("src")]
        : direction === "in"
          ? [side("dst")]
          : [side("src"), side("dst")];
    const neighbors = db.prepare(sides.join(" UNION ALL "));
    const seen = new Set([id]),
      seenEdges = new Set(),
      queue = [[id, 0]];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const [current, depth] = queue[cursor];
      if (depth >= hops) continue;
      for (const e of neighbors.iterate(
        relation === undefined ? { id: current } : { id: current, relation },
      )) {
        if (seenEdges.has(e.rowid)) continue;
        seenEdges.add(e.rowid);
        const next = current === e.src ? e.dst : e.src;
        const isNew = !seen.has(next);
        if (isNew) result.nodes.push(view(get.get(next).data));
        result.edges.push({
          source: e.src,
          target: e.dst,
          relation: e.kind,
          resolution: e.resolution,
          ...(e.ref ? { relation_id: e.ref } : {}),
          ...(e.via ? { via: e.via } : {}),
        });
        if (!fits()) {
          if (isNew) result.nodes.pop();
          result.edges.pop();
          result.truncated = true;
          return result;
        }
        if (isNew) {
          seen.add(next);
          queue.push([next, depth + 1]);
        }
      }
    }
    return result;
  });
}
