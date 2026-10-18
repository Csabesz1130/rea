// brief.md: the clean-room hand-off. It says what the compared products do
// and where a new product can differ, and carries no source code, commands,
// prompt text, file paths or string literals beyond the names of hosts,
// packages, providers and environment variables, so a team can build from
// it without reading the products' code.
import { verb } from "../opportunities.mjs";
import { TRAITS } from "../traits/definitions.mjs";
import { markdownCode, markdownText } from "../release-watch.mjs";
import {
  coverageWords,
  lookups,
  positionSections,
  summarySections,
} from "./text.mjs";

const text = markdownText;

// How many compared products name each value of a row: `[[value, count]]`.
const valueCounts = (row, compared) => {
  if (!row) return [];
  const counts = new Map();
  for (const product of compared)
    for (const value of row.cells[product.id].values ?? [])
      counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const countedList = (entries, n) =>
  entries
    .map(([value, count]) => `\`${markdownCode(value)}\` (${count} of ${n})`)
    .join(", ");

const interfaceLines = (model) => {
  const look = lookups(model);
  const n = look.compared.length;
  const providers = model.rows
    .filter((row) => row.provider)
    .map((row) => [row.provider, row.counts.held]);
  const environment = valueCounts(
    look.row(TRAITS.environmentKey.id),
    look.compared,
  );
  const servers = look.row(TRAITS.mcpServer.id);
  const sdks = model.stack.shared.filter((use) => use.kind === "sdk");
  return [
    ...(providers.length > 0
      ? [`- AI providers: ${countedList(providers, n)}`]
      : []),
    ...(environment.length > 0
      ? [
          `- Environment variables users already set: ${countedList(environment, n)}`,
        ]
      : []),
    ...(servers
      ? [
          `- ${servers.counts.held} of ${n} ${verb(servers.counts.held, "serves", "serve")} MCP tools, through ${text(
            sdks
              .filter((use) => use.sdk_kind !== "ai")
              .map((use) => use.name)
              .join(", ") || "an MCP SDK",
          )}`,
        ]
      : []),
    ...(sdks.length > 0
      ? [
          `- SDKs: ${countedList(
            sdks.map((use) => [use.name, use.products.length]),
            n,
          )}`,
        ]
      : []),
  ];
};

const sections = (list) =>
  list.flatMap(({ heading, lines }) => [
    `## ${text(heading)}`,
    "",
    ...lines.map((line) => `- ${text(line)}`),
    "",
  ]);

const TABLE_STAKES = {
  "What every product does": "Table stakes: what every product does",
  "What most products do": "What most products do",
  "What only one product does": "Where the products differ",
  "Risks the products expose their users to": "Risks they share",
};

/** Render brief.md for a map. */
export const renderBrief = (model) => {
  const look = lookups(model);
  const position = positionSections(model);
  const interfaces = interfaceLines(model);
  return [
    `# ${text(model.category)}: product brief`,
    "",
    `From the shipped code of ${look.compared.length} products, read with REA by Landscape on ${model.generated_at.slice(0, 10)}. This brief says what the products do, not how they are written: it carries no source code, commands, prompt text or file paths, only the names of hosts, packages, providers and environment variables, so a team can build from it without reading the products' code. The analyst's report.html cites the evidence behind every count.`,
    "",
    "## Products",
    "",
    ...look.compared.map(
      (product) => `- ${text(product.label)}: ${text(coverageWords(product))}`,
    ),
    "",
    ...sections(
      summarySections(model).map((section) => ({
        heading: TABLE_STAKES[section.heading] ?? section.heading,
        lines: section.lines,
      })),
    ),
    ...(model.openings.length > 0
      ? [
          "## Openings",
          "",
          ...model.openings.map(
            (opening, index) =>
              `${index + 1}. **${text(opening.title)}** (${opening.kind}). ${text(opening.finding)} ${text(opening.positioning)}`,
          ),
          "",
        ]
      : []),
    ...(interfaces.length > 0
      ? ["## Interfaces users already know", "", ...interfaces, ""]
      : []),
    ...(position
      ? sections(
          position.map((section) => ({
            heading: `${look.ours.label}: ${section.heading[0].toLowerCase()}${section.heading.slice(1)}`,
            lines: section.lines,
          })),
        )
      : []),
    "## Keep the difference true",
    "",
    "- Run Release Watch on each of your releases, so a difference you claim (no telemetry, no shell, local-first) cannot quietly regress.",
    "- Map the category again when the products ship; `landscape history` shows which way each one is moving.",
    "",
    "## What this brief does not establish",
    "",
    ...model.limitations.map((line) => `- ${text(line)}`),
    "",
  ].join("\n");
};
