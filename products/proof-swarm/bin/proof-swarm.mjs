#!/usr/bin/env node
// proof-swarm scan <package-dir>
// proof-swarm check <claim.json> --package <package-dir>
// proof-swarm collect <workflow-args.json> <workflow-result.json>
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { collect } from "../src/accept.mjs";
import { checkClaim } from "../src/check.mjs";
import { scan } from "../src/scan.mjs";

const USAGE = `Usage:
  proof-swarm scan <package-dir>
  proof-swarm check <claim.json> --package <package-dir>
  proof-swarm collect <workflow-args.json> <workflow-result.json>

scan: what a claim about the package's process reach must account for: the
files that load a process module or library, every candidate process call,
and every line that loads or evaluates code at runtime.

check: checks one claim (README.md: Claims) against the package's shipped
text and prints { status, errors, warnings, scan }.

collect: checks every claim file a swarm run wrote again, pairs it with the
run's reviews and prints { outcomes, records }. A claim is an answer only
when it passes the check and a consistent review upholds it.

No command runs, imports or installs anything from a package.

Exit status: 0 when a claim passes (or a scan or collection completes), 1
when it fails, 2 on usage errors.`;

const usage = (message) => {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({
    options: {
      package: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
} catch (error) {
  usage(error.message);
}
const { values, positionals } = parsed;
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const directory = (input) => {
  const root = path.resolve(input ?? "");
  if (!input || !existsSync(root) || !statSync(root).isDirectory())
    usage(`No package directory at ${root}`);
  return root;
};

const readJson = (file, what) => {
  if (!file) usage(`Name the ${what}.`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return usage(`Cannot read ${file} as JSON: ${error.message}`);
  }
};

const [command, target, second] = positionals;
if (command === "scan") {
  process.stdout.write(`${JSON.stringify(scan(directory(target)), null, 1)}\n`);
} else if (command === "check") {
  const claim = readJson(target, "claim file");
  const result = checkClaim(directory(values.package), claim);
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
  process.exitCode = result.status === "pass" ? 0 : 1;
} else if (command === "collect") {
  const args = readJson(target, "workflow's args file");
  const result = readJson(second, "workflow's result file");
  if (typeof args?.claims !== "string" || !Array.isArray(args?.batches))
    usage(`${target} is not workflow args: it needs claims and batches.`);
  for (const item of args.batches.flatMap((batch) => batch?.packages ?? [])) {
    if (typeof item?.name !== "string" || typeof item?.slug !== "string")
      usage(`Every package in ${target} needs a name and a slug.`);
    item.dir = directory(item.dir);
  }
  process.stdout.write(`${JSON.stringify(collect(args, result), null, 1)}\n`);
} else {
  usage(
    command
      ? `Unknown command: ${command}`
      : "Name a command: scan, check or collect.",
  );
}
