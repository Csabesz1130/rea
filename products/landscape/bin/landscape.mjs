#!/usr/bin/env node
// landscape map <product>... [options]
// landscape history <release>... [options]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { buildModel } from "../src/model.mjs";
import { collectProducts } from "../src/products.mjs";
import {
  analysisSettings,
  createRea,
  printable,
  resolveReaCommand,
} from "../src/release-watch.mjs";
import { renderBrief } from "../src/report/brief.mjs";
import { renderHtml } from "../src/report/html.mjs";
import { renderMarkdown } from "../src/report/markdown.mjs";
import { coverageWords } from "../src/report/text.mjs";

const USAGE = `Usage:
  landscape map <product>... [options]
  landscape history <release>... [options]

map: reads each product's shipped code with REA and maps what the products
do, what most or only one of them does, the risks they share and the
openings none of them covers. A <product> is anything Release Watch reads:
an Electron distribution directory, a JavaScript app or package directory
(package.json), a built web app (index.html or dist/), an .asar file, a HAR
capture, or a directory with a release-watch.json manifest.

  --category <name>   What the products are, for titles (default: "These products")
  --ours <product>    Your own product: mapped beside the others, not counted,
                      with where it stands against them

history: <release>... are releases of one product, oldest first; the report
shows which traits each release gained or lost.

  --out <dir>             Report directory (default: ./landscape-report)
  --rea <path>            REA CLI to use (default: this checkout, then \`rea\`)
  --depth <depth>         standard | deep: REA's semantic node limits (default: standard)
  --max-semantic-nodes <n>, --max-semantic-nodes-per-file <n>, --max-heap-mb <n>
                          Replace that one limit of the depth
  --jobs <1|2>            Products analyzed at once (default 2, 1 with deep)

Writes report.html, report.md, report.json and, for a map, brief.md: the
clean-room brief, which carries no code, commands or file paths. REA's
Evidence is saved under evidence/ and may hold the products' text.

Exit status: 0 when every product was analyzed, 1 when one could not be or
on usage errors.`;

const OPTIONS = {
  category: { type: "string" },
  ours: { type: "string" },
  out: { type: "string" },
  rea: { type: "string" },
  depth: { type: "string" },
  "max-semantic-nodes": { type: "string" },
  "max-semantic-nodes-per-file": { type: "string" },
  "max-heap-mb": { type: "string" },
  jobs: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const fail = (message) => {
  process.stderr.write(`${printable(message)}\n\n${USAGE}\n`);
  process.exit(1);
};

const parse = () => {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true });
  } catch (error) {
    fail(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const [mode, ...inputs] = positionals;
  if (mode !== "map" && mode !== "history")
    fail(mode ? `Unknown command: ${mode}` : "Name a command: map or history.");
  if (mode === "history" && values.ours !== undefined)
    fail("--ours applies to map, not history.");
  const needed = mode === "map" ? 2 - (values.ours === undefined ? 0 : 1) : 2;
  if (inputs.length < needed)
    fail(
      mode === "map"
        ? "Name at least two products, or one with --ours."
        : "Name at least two releases, oldest first.",
    );
  let settings;
  try {
    settings = analysisSettings(values);
  } catch (error) {
    fail(error.message);
  }
  return { mode, inputs, values, settings };
};

const requestsOf = ({ mode, inputs, values }) => [
  ...inputs.map((input) => ({
    input,
    role: mode === "history" ? "release" : "competitor",
  })),
  ...(values.ours === undefined ? [] : [{ input: values.ours, role: "ours" }]),
];

const main = async () => {
  const options = parse();
  const outDir = path.resolve(options.values.out ?? "landscape-report");
  mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();
  const rea = createRea(resolveReaCommand(options.values.rea));
  const requests = requestsOf(options);
  process.stderr.write(
    `Landscape: reading ${requests.length} ${options.mode === "history" ? "releases" : "products"} with REA (${options.settings.depth} depth, ${options.settings.jobs} at a time)\n`,
  );
  const products = await collectProducts({
    rea,
    requests,
    outDir,
    analysis: options.settings,
    onProduct: (product) =>
      process.stderr.write(
        `  ${product.id} ${printable(product.label)}: ${coverageWords(product)}${product.errors.length > 0 ? `, ${product.errors.length} error${product.errors.length === 1 ? "" : "s"}` : ""}\n`,
      ),
  });
  const model = buildModel(products, {
    mode: options.mode,
    category: options.values.category ?? "These products",
    settings: options.settings,
    reaCalls: rea.calls,
    startedAt,
    elapsedMs: Date.now() - startedAt,
  });
  const outputs = {
    "report.json": `${JSON.stringify(model, null, 2)}\n`,
    "report.md": renderMarkdown(model),
    "report.html": renderHtml(model),
    ...(options.mode === "map" ? { "brief.md": renderBrief(model) } : {}),
  };
  for (const [name, content] of Object.entries(outputs))
    writeFileSync(path.join(outDir, name), content);
  const openings = model.openings.map(
    (opening, index) => `  ${index + 1}. ${opening.title}: ${opening.finding}`,
  );
  process.stdout.write(
    [
      `${printable(model.category)}: ${model.products.length} ${options.mode === "history" ? "releases" : "products"}, ${model.rows.length} traits mapped`,
      ...(openings.length > 0 ? ["Openings:", ...openings.map(printable)] : []),
      ...(model.trajectory
        ? [`Changes across releases: ${model.trajectory.changes.length}`]
        : []),
      `Reports: ${Object.keys(outputs)
        .map((name) => path.join(outDir, name))
        .join(", ")}`,
      "",
    ].join("\n"),
  );
  process.exitCode = model.errors.length > 0 ? 1 : 0;
};

await main();
