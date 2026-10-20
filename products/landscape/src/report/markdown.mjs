// report.md: the summary, openings, position or trajectory, the full map
// and every cited evidence line, for reading in a terminal or a pull
// request. Renders the scrubbed report model only.
import { GROUPS } from "../traits/definitions.mjs";
import { markdownCode, markdownText } from "../release-watch.mjs";
import {
  MARKS,
  coverageWords,
  lookups,
  placeOf,
  positionSections,
  presentLines,
  summarySections,
  trajectorySections,
} from "./text.mjs";

const text = markdownText;

const bullets = (lines) => lines.map((line) => `- ${text(line)}`);

const sectioned = (sections, level = "###") =>
  sections.flatMap(({ heading, lines }) => [
    `${level} ${text(heading)}`,
    "",
    ...bullets(lines),
    "",
  ]);

const productTable = (model) => [
  "| | Product | Role | Coverage |",
  "|---|---|---|---|",
  ...model.products.map(
    (product) =>
      `| ${product.id} | ${text(product.label)} | ${product.role} | ${text(coverageWords(product))} |`,
  ),
  "",
];

const where = (location, product) => {
  const place = placeOf(location, product);
  return place ? ` \`${markdownCode(place)}\`` : "";
};

const evidenceLines = (model) =>
  model.rows.flatMap((row) => {
    const lines = model.products.flatMap((product) => {
      const cell = row.cells[product.id];
      if (cell.state === "no") return [];
      const head = `- **${text(product.label)}** ${MARKS[cell.state].mark} ${MARKS[cell.state].word}`;
      if (cell.state === "unknown")
        return [`${head}: ${text(cell.reasons.join("; "))}`];
      return [
        head,
        ...cell.evidence.map(
          (line) =>
            `  - ${text(line.claim)}${where(line.location, product)} (${text(line.source)}, ${line.basis})`,
        ),
        ...(cell.evidence_count > cell.evidence.length
          ? [
              `  - and ${cell.evidence_count - cell.evidence.length} more in report.json's Evidence files`,
            ]
          : []),
      ];
    });
    return lines.length > 0 ? [`### ${text(row.label)}`, "", ...lines, ""] : [];
  });

// Maps of more products than this read better with products as rows.
const WIDE = 8;

const LEGEND = `${Object.values(MARKS)
  .map((entry) => `${entry.mark} ${entry.word} (${entry.hint})`)
  .join(" · ")} · ⚠ a risk to users`;

// Products as rows and traits as columns, in GROUPS order.
const wideMapTable = (model) => {
  const rows = GROUPS.flatMap((group) =>
    model.rows.filter((row) => row.group === group.id),
  );
  return [
    `| Product | ${rows.map((row) => `${text(row.label)}${row.kind === "risk" ? " ⚠" : ""}`).join(" | ")} |`,
    `|---|${rows.map(() => ":-:").join("|")}|`,
    ...model.products.map(
      (product) =>
        `| ${text(product.label)} | ${rows.map((row) => MARKS[row.cells[product.id].state].mark).join(" | ")} |`,
    ),
    "",
    LEGEND,
    "",
  ];
};

/** The map as a Markdown table: traits as rows, or products as rows for a wide map. */
export const mapTable = (model) => {
  if (model.products.length > WIDE) return wideMapTable(model);
  const header = `| Trait | ${model.products.map((product) => text(product.label)).join(" | ")} |`;
  const rule = `|---|${model.products.map(() => ":-:").join("|")}|`;
  const lines = [header, rule];
  for (const group of GROUPS) {
    const rows = model.rows.filter((row) => row.group === group.id);
    if (rows.length === 0) continue;
    lines.push(
      `| **${text(group.label)}** |${model.products.map(() => " ").join("|")}|`,
    );
    for (const row of rows)
      lines.push(
        `| ${text(row.label)}${row.kind === "risk" ? " ⚠" : ""} | ${model.products.map((product) => MARKS[row.cells[product.id].state].mark).join(" | ")} |`,
      );
  }
  return [...lines, "", LEGEND, ""];
};

const openingLines = (model) =>
  model.openings.flatMap((opening, index) => [
    `${index + 1}. **${text(opening.title)}** (${opening.kind}). ${text(opening.finding)} ${text(opening.positioning)}`,
  ]);

const stackLines = (model) => {
  const look = lookups(model);
  if (model.stack.shared.length === 0) return [];
  return [
    "## Building blocks",
    "",
    "| Package | Kind | Used by |",
    "|---|---|---|",
    ...model.stack.shared.map(
      (use) =>
        `| \`${markdownCode(use.name)}\` | ${use.label ? text(use.label) : use.kind} | ${use.products.map((id) => text(look.product(id).label)).join(", ")} |`,
    ),
    "",
    `${model.stack.single_use_packages} other packages are used by one product each (report.json lists them per product).`,
    "",
  ];
};

const historyLines = (model) => {
  const sections = trajectorySections(model);
  if (sections === null) return [];
  return [
    "## How it changed",
    "",
    ...(presentLines(model).length > 0
      ? ["### Present from the start", "", ...bullets(presentLines(model)), ""]
      : []),
    ...sectioned(
      sections.map(({ version, lines }) => ({ heading: version, lines })),
    ),
    ...(sections.length === 0
      ? ["No trait changed between these releases.", ""]
      : []),
  ];
};

/** Render report.md. */
export const renderMarkdown = (model) => {
  const look = lookups(model);
  const position = positionSections(model);
  return [
    `# ${text(model.category)}: ${model.mode === "history" ? "how one product changed" : "category map"}`,
    "",
    `${model.products.length} ${model.mode === "history" ? "releases" : "products"} read from their shipped code with REA by Landscape on ${model.generated_at.slice(0, 10)}. Counts cover ${look.compared.length} ${model.mode === "history" ? "releases" : `compared product${look.compared.length === 1 ? "" : "s"}`}${look.ours ? `; ${text(look.ours.label)} is yours and is not counted` : ""}.`,
    "",
    ...productTable(model),
    ...(model.errors.length > 0
      ? [
          "## Errors",
          "",
          ...model.errors.map(
            (error) => `- ${error.product}: ${text(error.message)}`,
          ),
          "",
        ]
      : []),
    ...(model.mode === "map"
      ? ["## Summary", "", ...sectioned(summarySections(model))]
      : []),
    ...(model.openings.length > 0
      ? ["## Openings", "", ...openingLines(model), ""]
      : []),
    ...(position ? ["## Where you stand", "", ...sectioned(position)] : []),
    ...historyLines(model),
    "## Map",
    "",
    ...mapTable(model),
    "## Evidence",
    "",
    ...evidenceLines(model),
    ...stackLines(model),
    "## What this map does not establish",
    "",
    ...bullets(model.limitations),
    "",
    `REA calls: ${model.rea_calls.length}, ${(model.elapsed_ms / 1000).toFixed(1)} s in all. Analysis depth ${model.analysis.depth}.`,
    "",
  ].join("\n");
};
