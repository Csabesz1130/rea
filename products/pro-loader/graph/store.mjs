import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";

export const dbFile = (dir) => join(dir, "rea-graph.sqlite");
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
      "Directory does not contain a supported REA graph database",
    );
  return true;
}

const exactLabelIndex =
  "CREATE INDEX IF NOT EXISTS exact_labels ON nodes(json_extract(data,'$.label') COLLATE BINARY,id)";
export function openWriter(dir) {
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
    db.exec("BEGIN IMMEDIATE");
    if (!owned(db, true))
      db.exec(
        schema + " PRAGMA application_id=" + DB_ID + "; PRAGMA user_version=1",
      );
    db.exec(exactLabelIndex);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function queryGraph(dir, query) {
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

export const view = (data) => {
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
export const source = (meta) => ({
  evidence_id: meta.evidence_id,
  coverage: meta.coverage,
  ...(meta.source_truncated ? { source_truncated: true } : {}),
});

export function readSlice(
  db,
  meta,
  id,
  { hops, direction, budget, relation, evidence_id },
) {
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
}

export function sliceGraph(dir, id, input) {
  return queryGraph(dir, (db, meta) => readSlice(db, meta, id, input));
}
