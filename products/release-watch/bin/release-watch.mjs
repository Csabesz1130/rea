#!/usr/bin/env node
// release-watch compare <old> <new> [options]
// release-watch record <url> --out <file.har> [options]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { compareReleases } from "../src/compare.mjs";
import { createRea, resolveReaCommand } from "../src/rea.mjs";
import { parseStep, recordHar } from "../src/record.mjs";
import { renderHtml } from "../src/report/html.mjs";
import { renderMarkdown } from "../src/report/markdown.mjs";
import { printable } from "../src/redact.mjs";
import { reportJson } from "../src/report/model.mjs";
import { SEVERITIES } from "../src/rules/shared.mjs";

const USAGE = `Usage:
  release-watch compare <old> <new> [options]
  release-watch record <url> --out <file.har> [options]

compare: <old> and <new> are each an Electron distribution directory, a
JavaScript app directory (package.json), a built web app (index.html or
dist/), an .asar file, a HAR capture, or a directory with a
release-watch.json manifest listing several components.

  --out <dir>             Report directory (default: ./release-watch-report)
  --old-capture <har>     Runtime capture of the old release (single component)
  --new-capture <har>     Runtime capture of the new release (single component)
  --vendor-domain <name>  A domain the vendor owns; repeat for several
  --fail-on <severity>    critical | high | medium | low | never (default: high)
  --rea <path>            REA CLI to use (default: this checkout, then \`rea\`)
  --rea-compare <mode>    auto | always | never: ask REA to pair renamed modules
                          (default: auto, skipped when no file could be a
                          rename or the Evidence exceeds 64 MB)
  --max-semantic-nodes <n>, --max-semantic-nodes-per-file <n>, --max-heap-mb <n>
                          Passed to REA's JavaScript analysis for large bundles

record: loads <url> in Chromium, runs the steps, and saves a HAR without
response bodies.

  --out <file.har>        Where to write the capture (required)
  --step <step>           click:SEL | fill:SEL=TEXT | press:SEL=KEY | wait:MS |
                          waitfor:SEL | goto:PATH; repeat in order
  --settle-ms <ms>        Wait after the last step (default: 1000)
  --browser <path>        Chromium executable (default: CHROMIUM_PATH)
  --browser-arg <arg>     Extra Chromium argument; repeat for several

Exit status for compare: 0 below the threshold, 2 at or above it, 1 when a
component could not be analyzed or on usage errors.`;

const color = process.env.NO_COLOR
  ? false
  : Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
const paint = (code) => (text) =>
  color ? `\u001b[${code}m${text}\u001b[0m` : text;
const tone = {
  dim: paint("2"),
  bold: paint("1"),
  critical: paint("1;97;41"),
  high: paint("1;31"),
  medium: paint("1;33"),
  low: paint("1;34"),
  info: paint("2"),
  ok: paint("32"),
  fail: paint("31"),
  accent: paint("36"),
};
const DECISION_TONE = {
  block: paint("1;97;41"),
  review: paint("1;30;43"),
  pass: paint("1;30;42"),
  error: paint("1;97;41"),
};

const OPTIONS = {
  out: { type: "string" },
  "old-capture": { type: "string" },
  "new-capture": { type: "string" },
  "vendor-domain": { type: "string", multiple: true, default: [] },
  "fail-on": { type: "string", default: "high" },
  rea: { type: "string" },
  "rea-compare": { type: "string", default: "auto" },
  "max-semantic-nodes": { type: "string" },
  "max-semantic-nodes-per-file": { type: "string" },
  "max-heap-mb": { type: "string" },
  step: { type: "string", multiple: true, default: [] },
  "settle-ms": { type: "string", default: "1000" },
  browser: { type: "string" },
  "browser-arg": { type: "string", multiple: true, default: [] },
  help: { type: "boolean", default: false },
};

const ANALYSIS_LIMITS = [
  "max-semantic-nodes",
  "max-semantic-nodes-per-file",
  "max-heap-mb",
];

// "*.Example.com.", "https://example.com/x" and "example.com" name the same domain.
const vendorDomain = (value) => {
  const trimmed = value.trim().toLowerCase();
  let host = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      throw new Error(`--vendor-domain ${value} is not a domain or URL`);
    }
  }
  host = host.replace(/^\*\./, "").replace(/\.$/, "");
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(
      host,
    )
  )
    throw new Error(`--vendor-domain ${value} is not a domain`);
  return host;
};

const parse = () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: OPTIONS,
  });
  if (values.help || positionals.length === 0) return { command: "help" };
  const [command, ...operands] = positionals;
  if (command === "record") {
    if (operands.length !== 1 || !values.out)
      throw new Error("Expected: record <url> --out <file.har>");
    const settle = Number(values["settle-ms"]);
    if (!Number.isInteger(settle) || settle < 0)
      throw new Error("--settle-ms must be a whole number of milliseconds");
    return {
      command,
      url: operands[0],
      out: path.resolve(values.out),
      steps: values.step.map(parseStep),
      settleMs: settle,
      browser: values.browser ?? null,
      browserArgs: values["browser-arg"],
    };
  }
  if (command !== "compare" || operands.length !== 2)
    throw new Error("Expected: compare <old> <new>");
  if (values["fail-on"] !== "never" && !SEVERITIES.includes(values["fail-on"]))
    throw new Error(`--fail-on must be one of ${SEVERITIES.join(", ")}, never`);
  if (!["auto", "always", "never"].includes(values["rea-compare"]))
    throw new Error("--rea-compare must be one of auto, always, never");
  return {
    command,
    left: operands[0],
    right: operands[1],
    outDir: path.resolve(values.out ?? "release-watch-report"),
    rea: values.rea,
    options: {
      vendorDomains: values["vendor-domain"].map(vendorDomain),
      failOn: values["fail-on"],
      leftCapture: values["old-capture"] ?? null,
      rightCapture: values["new-capture"] ?? null,
      reaCompare: values["rea-compare"],
      analysisArgs: ANALYSIS_LIMITS.flatMap((name) => {
        if (values[name] === undefined) return [];
        if (!/^[1-9]\d*$/.test(values[name]))
          throw new Error(`--${name} must be a positive whole number`);
        return [`--${name}`, values[name]];
      }),
    },
  };
};

const progressLine = (call) => {
  const mark = call.ok ? tone.ok("✓") : tone.fail("✗");
  const seconds = `${(call.elapsed_ms / 1000).toFixed(1)} s`.padStart(7);
  console.log(
    `  ${mark} ${printable(call.label).padEnd(34)} ${tone.dim(seconds)}`,
  );
};

const shown = (outDir, file) => {
  const full = path.join(outDir, file);
  const relative = path.relative(process.cwd(), full);
  return relative.startsWith("..") ? full : relative;
};

const printSummary = (model, outDir) => {
  const { verdict } = model;
  const counts = ["critical", "high", "medium", "low"]
    .map((severity) =>
      tone[severity](`${verdict.counts[severity]} ${severity}`),
    )
    .join(tone.dim(" · "));
  console.log("");
  console.log(
    `${DECISION_TONE[verdict.decision](` ${verdict.decision.toUpperCase()} `)}  ${counts}`,
  );
  for (const error of model.errors)
    console.log(
      tone.fail(
        `  ${printable(error.component)} ${error.side}: ${printable(error.message)}`,
      ),
    );
  console.log("");
  const several = model.components.length > 1;
  for (const finding of model.findings) {
    const label = finding.severity.toUpperCase().padEnd(8);
    const where = several ? tone.dim(` [${printable(finding.component)}]`) : "";
    console.log(
      `  ${tone[finding.severity](label)} ${tone.dim(finding.id.padEnd(3))} ${printable(finding.title)}${where}`,
    );
  }
  console.log("");
  console.log(
    `${tone.dim("Report")} ${tone.accent(shown(outDir, "report.html"))}  ${tone.dim("JSON")} ${shown(outDir, "report.json")}  ${tone.dim("Markdown")} ${shown(outDir, "report.md")}`,
  );
  console.log(
    tone.dim(
      `${model.run.rea_calls.length} REA calls · ${(model.run.elapsed_ms / 1000).toFixed(1)} s · ${model.run.llm_tokens} LLM tokens`,
    ),
  );
};

const compare = async (args) => {
  const rea = createRea(resolveReaCommand(args.rea), { onCall: progressLine });
  console.log(
    `${tone.bold("Release Watch")} ${tone.dim("0.2.0 · static and runtime review on REA Evidence")}`,
  );
  const report = await compareReleases({
    left: args.left,
    right: args.right,
    outDir: args.outDir,
    rea,
    options: args.options,
  });
  const model = reportJson(report);
  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(
    path.join(args.outDir, "report.json"),
    `${JSON.stringify(model, null, 2)}\n`,
  );
  writeFileSync(path.join(args.outDir, "report.md"), renderMarkdown(model));
  writeFileSync(path.join(args.outDir, "report.html"), renderHtml(model));
  printSummary(model, args.outDir);
  if (model.verdict.decision === "error") return 1;
  return model.verdict.decision === "block" ? 2 : 0;
};

const record = async (args) => {
  await recordHar(args);
  console.log(`Saved ${args.out}`);
  return 0;
};

const main = async () => {
  let args;
  try {
    args = parse();
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (args.command === "help") {
    console.log(USAGE);
    return 0;
  }
  try {
    return args.command === "record" ? await record(args) : await compare(args);
  } catch (error) {
    console.error(tone.fail(printable(error.message)));
    return 1;
  }
};

process.exitCode = await main();
