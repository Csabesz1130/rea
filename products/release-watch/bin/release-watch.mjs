#!/usr/bin/env node
// release-watch compare <old-release> <new-release> [options]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { compareReleases } from "../src/compare.mjs";
import { createRea, resolveReaCommand } from "../src/rea.mjs";
import { renderHtml } from "../src/report/html.mjs";
import { renderMarkdown } from "../src/report/markdown.mjs";
import { reportJson } from "../src/report/model.mjs";
import { SEVERITIES } from "../src/rules/shared.mjs";

const USAGE = `Usage: release-watch compare <old-release> <new-release> [options]

A release is an Electron distribution directory, an extracted app directory,
or an .asar file.

Options:
  --out <dir>             Report directory (default: ./release-watch-report)
  --vendor-domain <name>  A domain the vendor owns; repeat for several
  --fail-on <severity>    critical | high | medium | low | never (default: high)
  --rea <path>            REA CLI to use (default: this checkout, then \`rea\`)
  --help                  Show this help

Exit status: 0 below the threshold, 2 at or above it, 1 on usage or analysis errors.`;

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
};

const parse = () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: "release-watch-report" },
      "vendor-domain": { type: "string", multiple: true, default: [] },
      "fail-on": { type: "string", default: "high" },
      rea: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return { help: true };
  const [command, left, right] = positionals;
  if (command !== "compare" || !left || !right || positionals.length !== 3)
    throw new Error("Expected: compare <old-release> <new-release>");
  if (values["fail-on"] !== "never" && !SEVERITIES.includes(values["fail-on"]))
    throw new Error(`--fail-on must be one of ${SEVERITIES.join(", ")}, never`);
  return {
    help: false,
    left,
    right,
    outDir: path.resolve(values.out),
    rea: values.rea,
    options: {
      vendorDomains: values["vendor-domain"].map((domain) =>
        domain.toLowerCase(),
      ),
      failOn: values["fail-on"],
    },
  };
};

const progressLine = (call) => {
  const mark = call.ok ? tone.ok("✓") : tone.fail("✗");
  const seconds = `${(call.elapsed_ms / 1000).toFixed(1)} s`.padStart(7);
  console.log(`  ${mark} ${call.label.padEnd(34)} ${tone.dim(seconds)}`);
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
  console.log("");
  for (const finding of model.findings) {
    const label = finding.severity.toUpperCase().padEnd(8);
    console.log(
      `  ${tone[finding.severity](label)} ${tone.dim(finding.id.padEnd(3))} ${finding.title}`,
    );
  }
  const relative = (file) => {
    const full = path.join(outDir, file);
    const shown = path.relative(process.cwd(), full);
    return shown.startsWith("..") ? full : shown;
  };
  console.log("");
  console.log(
    `${tone.dim("Report")} ${tone.accent(relative("report.html"))}  ${tone.dim("JSON")} ${relative("report.json")}  ${tone.dim("Markdown")} ${relative("report.md")}`,
  );
  console.log(
    tone.dim(
      `${model.run.rea_calls.length} REA calls · ${(model.run.elapsed_ms / 1000).toFixed(1)} s · ${model.run.llm_tokens} LLM tokens`,
    ),
  );
};

const main = async () => {
  let args;
  try {
    args = parse();
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const rea = createRea(resolveReaCommand(args.rea), { onCall: progressLine });
  console.log(
    `${tone.bold("Release Watch")} ${tone.dim("0.1.0 · static review on REA Evidence")}`,
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
  writeFileSync(path.join(args.outDir, "report.html"), renderHtml(report));
  printSummary(model, args.outDir);
  if (report.errors.length > 0) {
    for (const error of report.errors)
      console.error(
        tone.fail(`${error.side} ${error.operation}: ${error.message}`),
      );
    return 1;
  }
  return model.verdict.decision === "block" ? 2 : 0;
};

process.exitCode = await main();
