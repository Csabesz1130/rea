import { source } from "./store.mjs";

// Trial search uses the retained graph itself, including stores produced before
// trial ranking existed. An observed edge carries a discounted match to its
// other endpoint. The paid plugin maintains a precomputed TF-IDF vector index.
const terms = (s) =>
  (s ?? "")
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
export function rankedTrialSearch(db, meta, { query, kind, limit, offset }) {
  const wanted = new Set(terms(query));
  if (!wanted.size) return { ...source(meta), matches: [], more: false };
  const scoreText = (s) =>
    new Set(terms(typeof s === "string" ? s : "").filter((t) => wanted.has(t)))
      .size;
  db.function(
    "rea_trial_score",
    { deterministic: true, directOnly: true },
    (data) => {
      const n = JSON.parse(data);
      return (
        4 * scoreText(n.label) +
        2 * scoreText(n.kind) +
        scoreText(n.module) +
        Math.max(0, ...Object.values(n.properties ?? {}).map(scoreText))
      );
    },
  );
  const hits = db
    .prepare(`WITH direct AS MATERIALIZED (
    SELECT id, rea_trial_score(data) AS score FROM nodes
  ), seed AS MATERIALIZED (SELECT id,score FROM direct WHERE score>0),
  candidates AS (
    SELECT id,score FROM seed UNION ALL
    SELECT e.dst,0.25*s.score FROM seed s JOIN edges e ON e.src=s.id UNION ALL
    SELECT e.src,0.25*s.score FROM seed s JOIN edges e ON e.dst=s.id
  ), ranked AS (SELECT id,max(score) AS score FROM candidates GROUP BY id)
  SELECT n.data,r.score FROM ranked r JOIN nodes n ON n.id=r.id
  WHERE (? IS NULL OR json_extract(n.data,'$.kind')=?) ORDER BY r.score DESC,r.id LIMIT ? OFFSET ?`)
    .all(kind ?? null, kind ?? null, limit + 1, offset);
  return {
    ...source(meta),
    matches: hits.slice(0, limit).map(({ data, score }) => {
      const { id, kind, module, line, label } = JSON.parse(data);
      const abbreviated =
        typeof label === "string" ? label.slice(0, 240) : null;
      return {
        id,
        kind,
        module,
        line,
        label: abbreviated,
        ...(abbreviated !== label ? { label_truncated: true } : {}),
        score,
      };
    }),
    more: hits.length > limit,
  };
}
