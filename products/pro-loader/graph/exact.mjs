import { source } from "./store.mjs";

// The expression matches the index created by the writer. Old stores remain
// readable through SQLite's scan fallback and gain the index on the next rebuild.
export function exactRoute(db, meta, { query, limit, offset, kind, mode }) {
  if (mode === "semantic") return null;
  const where = kind === undefined ? "" : " AND json_extract(data,'$.kind')=?";
  const args = kind === undefined ? [query] : [query, kind];
  const identity = db
    .prepare("SELECT data FROM nodes WHERE id=?" + where)
    .get(...args);
  const name =
    " FROM nodes WHERE json_extract(data,'$.label') COLLATE BINARY=?" + where;
  let rows;
  if (identity) {
    rows = offset === 0 ? [identity] : [];
  } else {
    rows = db
      .prepare("SELECT data" + name + " ORDER BY id LIMIT ? OFFSET ?")
      .all(...args, limit + 1, offset);
    if (
      !rows.length &&
      mode !== "exact" &&
      !(offset && db.prepare("SELECT 1" + name + " LIMIT 1").get(...args))
    )
      return null;
  }
  const matches = rows.slice(0, limit).map(({ data }) => {
    const { id, kind, label, module, line } = JSON.parse(data);
    if (typeof label === "string" && label.length > 240)
      return {
        id,
        kind,
        label: label.slice(0, 240),
        label_truncated: true,
        module,
        line,
      };
    return { id, kind, label, module, line };
  });
  return { ...source(meta), matches, more: rows.length > limit };
}
