// Measure an equivalent source-location task with full Evidence and real stdio
// traffic. Run on the two Notes fixture builds described in README.md.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { tokens } from "./graph/store.mjs";

const [evidence, store] = process.argv.slice(2);
if (!evidence || !store)
  throw new Error(
    "Usage: node products/pro-loader/benchmark.mjs EVIDENCE STORE",
  );
const raw = JSON.parse(readFileSync(evidence, "utf8")),
  g = raw.normalized_result.semantic_graph;
const expected = g.nodes.find(
  (n) =>
    n.label === "toCsv" &&
    n.kind === "function" &&
    n.identity.module_path === "csv.js",
);
assert.ok(expected, "The Notes fixture must declare toCsv in csv.js");
const writeTime = performance.now();
const fullTokens = tokens(JSON.stringify(raw));
const tokenizationMs = Math.round(performance.now() - writeTime);
const start = performance.now();
const proc = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
    "pro",
    "mcp",
    "--store",
    store,
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);
// Graph queries run in this one server process. Sample Linux RSS and the
// kernel's accumulated process CPU ticks without attributing client tokenization.
const hz =
  process.platform === "linux"
    ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }))
    : null;
let peakKiB = 0;
function sample() {
  if (!hz) return null;
  const line = readFileSync("/proc/" + proc.pid + "/stat", "utf8");
  const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
  const rss = Number(
    /^VmRSS:\s+(\d+)/m.exec(
      readFileSync("/proc/" + proc.pid + "/status", "utf8"),
    )?.[1] ?? 0,
  );
  peakKiB = Math.max(peakKiB, rss);
  return ((Number(fields[11]) + Number(fields[12])) * 1000) / hz;
}
const sampler = setInterval(() => {
  try {
    sample();
  } catch {}
}, 10);
const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
const closed = new Promise((resolve) => proc.once("close", resolve));
const wire = [];
const send = (obj) => {
  const s = JSON.stringify(obj);
  wire.push(s);
  proc.stdin.write(s + "\n");
};
let serial = 0;
let locked;
async function request(method, params = {}) {
  const id = ++serial;
  send({ jsonrpc: "2.0", id, method, params });
  for (;;) {
    const { value, done } = await lines.next();
    if (done) throw new Error("MCP server exited");
    wire.push(value);
    const msg = JSON.parse(value);
    if (msg.id !== id) continue;
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  }
}
async function call(name, args) {
  const r = await request("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  const value = JSON.parse(r.content[0].text);
  if (value.status === "LICENSE_REQUIRED") {
    locked = value;
    throw new Error(
      "Four full queries are required for cold and warm measurements",
    );
  }
  return value;
}
async function locate() {
  const candidates = await call("graph_search", {
    query: "toCsv",
    kind: "function",
    limit: 1,
  });
  const found = candidates.matches.find(
    (n) =>
      n.kind === "function" && n.label === "toCsv" && n.module === "csv.js",
  );
  assert.equal(found?.id, expected.node_id);
  assert.equal(found.line, expected.identity.source_range.start.line);
  const slice = await call("graph_slice", {
    id: found.id,
    hops: 1,
    relation: "contains",
    direction: "out",
    budget: 750,
  });
  assert.ok(
    slice.nodes.some((n) =>
      g.nodes.some(
        (o) => o.node_id === n.id && o.function_node_id === found.id,
      ),
    ),
  );
  assert.ok(tokens(JSON.stringify(slice)) <= 750);
}
try {
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "rea-pro-benchmark", version: "1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await request("tools/list");
  await locate();
  const coldMs = Math.round(performance.now() - start),
    cold = wire.splice(0);
  const coldCpu = sample(),
    coldRss = peakKiB;
  peakKiB = 0;
  sample();
  const warmStart = performance.now();
  await locate();
  const warmMs = Math.round(performance.now() - warmStart);
  const endCpu = sample();
  const sum = (xs) => xs.reduce((n, text) => n + tokens(text), 0);
  console.log(
    JSON.stringify({
      evidence_id: raw.evidence_id,
      source_nodes: g.nodes.length,
      source_relations: g.relations.length,
      full_evidence_tokens: fullTokens,
      cold_wire_tokens: sum(cold),
      warm_wire_tokens: sum(wire),
      cold_ms: coldMs,
      cold_cpu_ms: coldCpu,
      cold_peak_rss_kib: hz ? coldRss : null,
      warm_cpu_ms: hz ? endCpu - coldCpu : null,
      warm_peak_rss_kib: hz ? peakKiB : null,
      warm_ms: warmMs,
      baseline_tokenization_ms: tokenizationMs,
    }),
  );
} catch (error) {
  if (!locked) throw error;
  // A partial run cannot supply equivalent cold/warm measurements.
  process.stdout.write(JSON.stringify(locked) + "\n");
  process.exitCode = 2;
} finally {
  clearInterval(sampler);
  proc.stdin.end();
  await closed;
}
