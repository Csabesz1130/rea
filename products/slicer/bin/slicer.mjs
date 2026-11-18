#!/usr/bin/env node
// slicer index <evidence.json> --store <dir>
// slicer summary --store <dir>
// slicer find <term> --store <dir> [--limit <n>]
// slicer slice <node-id> --store <dir> [--hops <n>] [--budget <tokens>]
// slicer stats --store <dir>
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { indexEvidence } from "../src/index-evidence.mjs";
import { search, slice, summary } from "../src/slice.mjs";
import { indexBytes, readIndex, writeIndex } from "../src/store.mjs";
import { estimateTokens } from "../src/tokens.mjs";

const USAGE = `Usage:
  slicer index <evidence.json> --store <dir>
  slicer summary --store <dir>
  slicer find <term> --store <dir> [--limit <n>]
  slicer slice <node-id> --store <dir> [--hops <n>] [--budget <tokens>]
  slicer stats --store <dir>

index: reads one REA analyze_javascript_application Evidence record and
builds a compact index of its semantic graph under --store: the nodes and
relations stripped to id, kind, location, label and a few properties, an
adjacency map, a lexical index, and a short surface summary. The Evidence's
own bytes are not kept. A large Evidence is read whole, so index once with a
large Node heap (e.g. NODE_OPTIONS=--max-old-space-size=8192); every query
after is small.

summary: prints what the whole Evidence is about — counts by kind and
module, and the notable nodes (requests and hosts, process executions and
commands, config-file reads, literals) — each with the node id to slice next.

find: prints the nodes whose label, module or a kept string property matches
<term>, each with its id and location.

slice: prints the neighbourhood of one node out to --hops edges (default 2)
in either direction, with the edges among the kept nodes. --budget (default
1500) bounds the estimated tokens of the nodes, nearest kept first; the whole
slice adds the edges and a small envelope, so estimated_tokens can exceed the
budget by that overhead while nodes_tokens stays within it.

stats: prints the index's size and counts.

Tokens are an estimate, the character length over four; the slicer is local
and names no model, so it reports no exact token count. Output is JSON on
stdout. Exit status: 0 done, 1 cannot run, 2 usage.`;

const usage = (message) => {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({
    options: {
      store: { type: "string" },
      limit: { type: "string" },
      hops: { type: "string" },
      budget: { type: "string" },
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

const [command, target] = positionals;
if (!["index", "summary", "find", "slice", "stats"].includes(command))
  usage(
    command
      ? `Unknown command: ${command}`
      : "Name a command: index, summary, find, slice or stats.",
  );

const count = (name, fallback, min = 1) => {
  if (values[name] === undefined) return fallback;
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < min)
    usage(`--${name} takes a whole number of at least ${min}.`);
  return value;
};

const fail = (message) => {
  process.stderr.write(`slicer: ${message}\n`);
  process.exit(1);
};

const print = (value) =>
  process.stdout.write(`${JSON.stringify(value, null, 1)}\n`);

if (command === "index") {
  if (!target) usage("Name the Evidence JSON file to index.");
  if (!values.store) usage("Name the index directory with --store.");
  const store = path.resolve(values.store);
  let evidence;
  let inputBytes;
  try {
    inputBytes = statSync(target).size;
    evidence = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    fail(`cannot read ${target}: ${error.message}`);
  }
  let index;
  try {
    index = indexEvidence(evidence);
  } catch (error) {
    fail(error.message);
  }
  writeIndex(store, index);
  const built = indexBytes(store);
  print({
    store,
    subject: index.meta.subject,
    counts: index.meta.counts,
    input_bytes: inputBytes,
    index_bytes: built,
    input_tokens_estimate: estimateTokens(JSON.stringify(evidence)),
    index_tokens_estimate: estimateTokens(
      JSON.stringify([index.meta, index.surface]),
    ),
  });
} else {
  if (!values.store) usage("Name the index directory with --store.");
  let index;
  try {
    index = readIndex(path.resolve(values.store));
  } catch (error) {
    fail(error.message);
  }
  if (command === "summary") print(summary(index));
  else if (command === "stats")
    print({
      store: path.resolve(values.store),
      subject: index.meta.subject,
      coverage: index.meta.coverage,
      counts: index.meta.counts,
      index_bytes: indexBytes(path.resolve(values.store)),
    });
  else if (command === "find") {
    if (!target) usage("Name the term to find.");
    print(search(index, target, { limit: count("limit", 20) }));
  } else {
    if (!target) usage("Name the node id to slice.");
    const result = slice(index, target, {
      hops: count("hops", 2),
      budget: count("budget", 1500, 50),
    });
    if (result.error) fail(result.error);
    print(result);
  }
}
