#!/usr/bin/env node
// proof-swarm scan <package-dir>
// proof-swarm sketch <package-dir> [--level <0-3>] [--rea]
// proof-swarm check <claim.json> --package <package-dir>
// proof-swarm plan <workflow-args.json> [--rea]
// proof-swarm collect <workflow-args.json> <workflow-result.json>
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { collect } from "../src/accept.mjs";
import { plan } from "../src/plan.mjs";
import { checkClaim } from "../src/check.mjs";
import { scan } from "../src/scan.mjs";
import { sketch, sketchWithRea } from "../src/sketch.mjs";

const USAGE = `Usage:
  proof-swarm scan <package-dir>
  proof-swarm sketch <package-dir> [--level <0-3>] [--rea]
  proof-swarm check <claim.json> --package <package-dir>
  proof-swarm plan <workflow-args.json> [--rea]
  proof-swarm collect <workflow-args.json> <workflow-result.json>

scan: what a claim about the package's process reach must account for: the
files that load a process module or library, every candidate process call,
and every line that loads or evaluates code at runtime.

sketch: the package coarse to fine, in levels up to --level (default 3):
the package and its verdict, its entry points, the files the question turns
on, and the lines left open. Level 0 says "no" when nothing that can run
starts a process; finer levels list only what coarser ones leave open. With
--rea, where REA's parse could settle the package, REA analyzes the files
that hold its open lines and rules out matches that are no call, load or
evaluation (in a string, a regex, a comment or a definition). It needs this
checkout's REA build or REA_CLI.

check: checks one claim (README.md: Claims) against the package's shipped
text and prints { status, errors, warnings, scan }.

plan: sketches every package in a workflow's args and prints the args again:
packages level 0 settles move to settled, and every other package carries
its sketch's levels 0 to 2 for the agents. --rea sketches with REA.

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
      level: { type: "string" },
      rea: { type: "boolean" },
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

// A workflow's args, with every package's directory checked and resolved.
const workflowArgs = (file) => {
  const args = readJson(file, "workflow's args file");
  if (typeof args?.claims !== "string" || !Array.isArray(args?.batches))
    usage(`${file} is not workflow args: it needs claims and batches.`);
  const packages = [
    ...args.batches.flatMap((batch) => batch?.packages ?? []),
    ...(Array.isArray(args.settled) ? args.settled : []),
  ];
  for (const item of packages) {
    if (typeof item?.name !== "string" || typeof item?.slug !== "string")
      usage(`Every package in ${file} needs a name and a slug.`);
    item.dir = directory(item.dir);
  }
  return args;
};

const [command, target, second] = positionals;
if (command === "scan") {
  process.stdout.write(`${JSON.stringify(scan(directory(target)), null, 1)}\n`);
} else if (command === "check") {
  const claim = readJson(target, "claim file");
  const result = checkClaim(directory(values.package), claim);
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
  process.exitCode = result.status === "pass" ? 0 : 1;
} else if (command === "sketch") {
  const level = values.level === undefined ? 3 : Number(values.level);
  if (![0, 1, 2, 3].includes(level)) usage("--level is 0, 1, 2 or 3.");
  const root = directory(target);
  const { levels } = values.rea ? await sketchWithRea(root) : sketch(root);
  process.stdout.write(
    `${JSON.stringify({ levels: levels.filter((item) => item.level <= level) }, null, 1)}\n`,
  );
} else if (command === "plan" || command === "collect") {
  const args = workflowArgs(target);
  const output =
    command === "plan"
      ? await plan(args, { rea: values.rea === true })
      : await collect(args, readJson(second, "workflow's result file"));
  process.stdout.write(`${JSON.stringify(output, null, 1)}\n`);
} else {
  usage(
    command
      ? `Unknown command: ${command}`
      : "Name a command: scan, sketch, check, plan or collect.",
  );
}
