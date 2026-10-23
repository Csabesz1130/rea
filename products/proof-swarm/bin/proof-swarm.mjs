#!/usr/bin/env node
// proof-swarm scan <package-dir>
// proof-swarm check <claim.json> --package <package-dir>
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { checkClaim } from "../src/check.mjs";
import { scan } from "../src/scan.mjs";

const USAGE = `Usage:
  proof-swarm scan <package-dir>
  proof-swarm check <claim.json> --package <package-dir>

scan: what a claim about the package's process reach must account for: the
files that load a process module or library, every candidate process call,
and every line that loads or evaluates code at runtime.

check: checks one claim (README.md: Claims) against the package's shipped
text and prints { status, errors, warnings, scan }.

Neither command runs, imports or installs anything from the package.

Exit status: 0 when a claim passes (or a scan completes), 1 when it fails,
2 on usage errors.`;

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

const [command, target] = positionals;
if (command === "scan") {
  process.stdout.write(`${JSON.stringify(scan(directory(target)), null, 1)}\n`);
} else if (command === "check") {
  if (!target) usage("Name the claim file.");
  const root = directory(values.package);
  let claim;
  try {
    claim = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    usage(`Cannot read ${target} as JSON: ${error.message}`);
  }
  const result = checkClaim(root, claim);
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
  process.exitCode = result.status === "pass" ? 0 : 1;
} else {
  usage(
    command ? `Unknown command: ${command}` : "Name a command: scan or check.",
  );
}
