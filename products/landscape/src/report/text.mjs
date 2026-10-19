// Wording every output shares: cell marks, row lookups and the sentences
// that say what a map's summary, openings, position and trajectory found.
import { countText } from "../opportunities.mjs";

/** How each cell state is marked and read. */
export const MARKS = {
  yes: { mark: "●", word: "Yes", hint: "REA's facts show it" },
  likely: { mark: "◐", word: "Likely", hint: "only a guess suggests it" },
  no: { mark: "–", word: "Not seen", hint: "not observed where REA looked" },
  unknown: { mark: "?", word: "Unknown", hint: "REA's facts cannot tell" },
};

/** Lookups over a report model. */
export const lookups = (model) => {
  const rows = new Map(model.rows.map((row) => [row.id, row]));
  const products = new Map(
    model.products.map((product) => [product.id, product]),
  );
  const compared = model.products.filter((product) => product.role !== "ours");
  return {
    row: (id) => rows.get(id),
    product: (id) => products.get(id),
    compared,
    ours: model.products.find((product) => product.role === "ours") ?? null,
  };
};

/** "Calls OpenAI — 4 of 5 (1 only likely)". */
export const rowCount = (row, n) =>
  `${row.label} — ${countText(row.counts, n)}`;

const nameList = (names) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The summary as sentences: `[{ heading, lines }]`, empty sections left out. */
export const summarySections = (model) => {
  const look = lookups(model);
  const n = look.compared.length;
  const rowsOf = (list) => list.map((id) => look.row(id));
  return [
    {
      heading: "What every product does",
      lines: rowsOf(model.summary.universal).map((row) => rowCount(row, n)),
    },
    {
      heading: "What most products do",
      lines: rowsOf(model.summary.common).map((row) => rowCount(row, n)),
    },
    {
      heading: "What only one product does",
      lines: model.summary.distinct.map(
        ({ row, product }) =>
          `${look.row(row).label} — only ${look.product(product).label}`,
      ),
    },
    {
      heading: "Risks the products expose their users to",
      lines: rowsOf(model.summary.risks).map((row) => rowCount(row, n)),
    },
  ].filter((section) => section.lines.length > 0);
};

/** The caller's position as sentences, or null. */
export const positionSections = (model) => {
  if (!model.position) return null;
  const look = lookups(model);
  const n = look.compared.length;
  const labels = (list) => list.map((id) => rowCount(look.row(id), n));
  return [
    { heading: "You match", lines: labels(model.position.matches) },
    {
      heading: "Most of them do this and you do not",
      lines: labels(model.position.gaps),
    },
    {
      heading: "Only you do this",
      lines: model.position.edges.map((id) => look.row(id).label),
    },
    {
      heading:
        "Risks most of them show and you do not, where REA examined all your code",
      lines: labels(model.position.clear),
    },
    { heading: "Risks you share", lines: labels(model.position.risks) },
  ].filter((section) => section.lines.length > 0);
};

/** A trajectory's changes as `[{ version, lines }]`, one entry per release with changes. */
export const trajectorySections = (model) => {
  if (!model.trajectory) return null;
  const look = lookups(model);
  const byVersion = new Map();
  for (const change of model.trajectory.changes) {
    const label = look.product(change.version).label;
    if (!byVersion.has(label)) byVersion.set(label, []);
    const since = look.product(change.since).label;
    byVersion
      .get(label)
      .push(
        `${change.kind === "appeared" ? "Now seen" : "No longer seen"}: ${look.row(change.row).label}${change.adjacent ? "" : ` (last settled in ${since})`}`,
      );
  }
  return [...byVersion].map(([version, lines]) => ({ version, lines }));
};

/** The traits a history's first settled releases already show. */
export const presentLines = (model) => {
  if (!model.trajectory) return [];
  const look = lookups(model);
  return model.trajectory.present.map(
    ({ row, version }) =>
      `${look.row(row).label} (from ${look.product(version).label})`,
  );
};

/** The values a row's cells name across products, such as provider hosts. */
export const rowValues = (row) =>
  nameList([
    ...new Set(Object.values(row.cells).flatMap((cell) => cell.values ?? [])),
  ]);

/** How much of a product REA examined, in words. */
export const coverageWords = (product) => {
  if (product.coverage.status === "complete")
    return "REA examined all of its code";
  if (product.coverage.status === "none")
    return "REA produced no application facts";
  const files = product.coverage.components.reduce(
    (sum, part) => sum + part.file_count,
    0,
  );
  return files > 0
    ? `REA examined ${files} file${files === 1 ? "" : "s"} only in part or not at all`
    : "REA examined its code only in part";
};

/** Where an evidence line was seen; the component is named only for a product with several. */
export const placeOf = (location, product) =>
  location?.file
    ? `${location.component && product.components.length > 1 ? `${location.component}/` : ""}${location.file}${location.line ? `:${location.line}` : ""}`
    : null;
