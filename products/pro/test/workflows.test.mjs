import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { openRuntimeTrace } from "../src/runtime.mjs";
import {
  tokens,
  buildGraph,
  graphStats,
  searchGraph,
  sliceGraph,
} from "../src/graph.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url)),
  cli = join(root, "scripts/rea.mjs");
const tmp = mkdtempSync(join(tmpdir(), "rea-pro-test-")),
  store = join(tmp, "index"),
  trace = join(tmp, "trace.ndjson");
const env = {
  ...process.env,
  REA_PRO_HOME: join(tmp, "profile"),
  REA_PRO_CONFIG: join(tmp, "issuer.json"),
};
const issuer = "https://issuer.test",
  keys = generateKeyPairSync("ed25519");
const grant = (changes = {}) => {
  const encode = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const base =
    encode({ alg: "EdDSA" }) +
    "." +
    encode({
      iss: issuer,
      sub: "tester",
      aud: "rea-pro",
      exp: Math.floor(Date.now() / 1000) + 3600,
      scope: "rea:graph rea:runtime rea:recovery",
      ...changes,
    });
  return (
    base +
    "." +
    sign(null, Buffer.from(base), keys.privateKey).toString("base64url")
  );
};
function call(args, input) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env,
    input,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.ifError(r.error);
  return r;
}
function ok(args, input) {
  const r = call(args, input);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const cmd = (...args) => ok(["pro", ...args]);
const fixture = join(
  root,
  "products/slicer/test/fixtures/credentials-app.evidence.json",
);
before(() => {
  writeFileSync(
    env.REA_PRO_CONFIG,
    JSON.stringify({
      issuer,
      public_key: keys.publicKey.export({ type: "spki", format: "pem" }),
    }),
  );
  ok(["login", "--token-stdin"], grant());
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test("login rejects unsigned, expired and wrong audience grants without replacing a valid session", () => {
  for (const bad of [
    "bogus",
    grant({ exp: 1 }),
    grant({ aud: "other" }),
    grant({ nbf: 2e10 }),
    grant({ iss: "wrong" }),
  ]) {
    assert.notEqual(call(["login", "--token-stdin"], bad).status, 0);
  }
  assert.deepEqual(cmd("status").features, ["graph", "runtime", "recovery"]);
  if (process.platform !== "win32")
    assert.equal(
      statSync(join(env.REA_PRO_HOME, "session.jwt")).mode & 0o777,
      0o600,
    );
});
test("streamed producer Evidence, complete slice budgets, search paging and failed atomic replacement", () => {
  const stats = cmd("index", fixture, "--store", store);
  assert.equal(stats.nodes, 47);
  assert.equal(stats.source_edges, 34);
  assert.ok(stats.ownership_edges > 0);
  const hits = cmd("search", "index", "--store", store, "--limit", "3");
  assert.equal(
    cmd("search", "index", "--store", store, "--offset", "1", "--limit", "1")
      .matches[0].id,
    hits.matches[1].id,
  );
  const id = hits.matches[0].id;
  for (const budget of [160, 255, 512, 1500]) {
    const r = cmd("slice", id, "--store", store, "--budget", String(budget));
    const ids = new Set(r.nodes.map((n) => n.id));
    assert.ok(ids.has(id));
    assert.ok(tokens(JSON.stringify(r)) <= budget);
    for (const e of r.edges) assert.ok(ids.has(e.source) && ids.has(e.target));
  }
  assert.notEqual(
    call(["pro", "slice", id, "--store", store, "--evidence-id", "changed"])
      .status,
    0,
  );
  const bad = join(tmp, "bad.json");
  writeFileSync(bad, readFileSync(fixture).subarray(0, -10));
  assert.notEqual(call(["pro", "index", bad, "--store", store]).status, 0);
  assert.deepEqual(cmd("stats", "--store", store), stats);
});
test("backward native graphs retain failed observations and directed calls", () => {
  const file = join(tmp, "native.json"),
    dir = join(tmp, "native");
  const row = (address, calls) => ({
    address,
    status: "ok",
    calls,
    relationship_coverage: { status: "partial", limitations: ["exercise"] },
  });
  // Put parameters after data to exercise streaming order independence.
  writeFileSync(
    file,
    JSON.stringify({
      operation: "get_call_graph",
      evidence_id: "native-test",
      normalized_result: {
        graph: {
          0: [row("0x1000", ["0x2000"])],
          1: [
            { address: "0x2000", status: "error", error: { code: "partial" } },
          ],
        },
      },
      parameters: { direction: "backward" },
    }),
  );
  cmd("index", file, "--store", dir);
  const r = cmd("slice", "0x1000", "--store", dir, "--direction", "in");
  assert.deepEqual(
    r.edges.map((e) => [e.source, e.target]),
    [["0x2000", "0x1000"]],
  );
  assert.equal(r.nodes[1].properties.status, "error");
  assert.deepEqual(
    cmd("slice", "0x1000", "--store", dir, "--direction", "out").edges,
    [],
  );
});
test("real Electron ASAR producer, graph and non-clobbering single-member extraction", async () => {
  const notes = join(root, "website/public/examples/notes-electron"),
    asar = join(tmp, "notes.asar"),
    e = join(tmp, "notes.json"),
    dir = join(tmp, "notes-index");
  await createPackage(notes, asar);
  const stats = cmd("index-bundle", asar, "--store", dir, "--evidence-out", e);
  assert.equal(stats.subject, "notes.asar");
  assert.ok(stats.nodes > 50);
  const hits = cmd("search", "to csv", "--store", dir);
  assert.ok(
    hits.matches.some((n) => n.module === "csv.js" && n.label === "toCsv"),
  );
  const out = join(tmp, "csv-copy.js");
  const extracted = cmd("extract", asar, "csv.js", "--out", out);
  assert.equal(extracted.bytes, statSync(join(notes, "csv.js")).size);
  assert.deepEqual(readFileSync(out), readFileSync(join(notes, "csv.js")));
  assert.notEqual(
    call(["pro", "extract", asar, "csv.js", "--out", out]).status,
    0,
  );
  assert.notEqual(
    call(["pro", "extract", asar, "missing", "--out", out + "2"]).status,
    0,
  );
  assert.equal(existsSync(out + "2"), false);
});
test("AST values, paged matches, source map location and R8 overload ranges", () => {
  const js = join(tmp, "example.js"),
    map = join(tmp, "example.map"),
    mapping = join(tmp, "mapping.txt");
  writeFileSync(
    js,
    'export const a=("hello" + " world"), b=(10 << 2), c=(1+2)*3; doThing();',
  );
  const page = cmd("explain-js", "--script", js, "--limit", "1");
  assert.equal(page.matches[0].value, "hello world");
  assert.deepEqual(
    cmd(
      "explain-js",
      "--script",
      js,
      "--offset",
      String(page.next_offset),
    ).matches.map((m) => m.value),
    [9],
  );
  writeFileSync(
    map,
    JSON.stringify({
      version: 3,
      sources: ["src/editor.ts"],
      sourcesContent: ["const title = 1;"],
      names: ["title"],
      mappings: "AAAAA",
    }),
  );
  const mapped = cmd(
    "source-position",
    "--map",
    map,
    "--line",
    "1",
    "--column",
    "4",
  );
  assert.equal(mapped.matches[0].source, "src/editor.ts");
  assert.match(mapped.matches[0].excerpt, /title/);
  writeFileSync(
    mapping,
    "demo.Editor -> a:\n    1:4:void open():10:13 -> b\n    5:8:void open(int):20:23 -> b\n    5:8:void demo.Helper.save():42 -> b\n",
  );
  const r = cmd(
    "r8-symbol",
    "a",
    "--mapping",
    mapping,
    "--method",
    "b",
    "--line",
    "6",
  );
  assert.deepEqual(
    r.matches.map((m) => m.original_class),
    ["demo.Editor", "demo.Helper"],
  );
  assert.deepEqual(r.matches[0].original_range, [20, 23]);
  assert.equal(
    cmd(
      "r8-symbol",
      "a",
      "--mapping",
      mapping,
      "--method",
      "b",
      "--offset",
      "2",
      "--limit",
      "1",
    ).matches[0].mapping_line,
    4,
  );
});
test("real stdio client follows live app events, partial writes, rotation and logout", async () => {
  const t = openRuntimeTrace(trace);
  t.mark("editor.open");
  t.sample();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "pro", "mcp", "--store", store, "--trace", trace],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "pro-test", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "graph_search",
      "graph_slice",
      "graph_stats",
      "runtime_events",
    ]);
    const run = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return JSON.parse(r.content[0].text);
    };
    const search = await run("graph_search", { query: "index", limit: 1 });
    const slice = await run("graph_slice", {
      id: search.matches[0].id,
      budget: 200,
    });
    assert.ok(tokens(JSON.stringify(slice)) <= 200);
    const first = await run("runtime_events", { limit: 1 });
    assert.equal(first.events[0].name, "editor.open");
    const second = await run("runtime_events", { cursor: first.cursor });
    assert.equal(second.events[0].type, "resources");
    const later = run("runtime_events", {
      cursor: second.cursor,
      wait_ms: 2000,
    });
    setTimeout(() => t.measure("editor.paint", 12), 60);
    assert.equal((await later).events[0].duration_ms, 12);
    t.close();
    appendFileSync(trace, '{"type":"mark"');
    const partial = await run("runtime_events", {});
    assert.equal(partial.partial, true);
    appendFileSync(trace, ',"seq":3,"name":"ready","at_ms":2}\n');
    assert.equal(
      (await run("runtime_events", { cursor: partial.cursor })).events[0].name,
      "ready",
    );
    renameSync(trace, trace + ".old");
    const next = openRuntimeTrace(trace);
    next.mark("new run");
    next.close();
    assert.equal(
      (await run("runtime_events", { cursor: partial.cursor })).reset,
      true,
    );
    assert.equal(cmd("logout").signed_in, false);
    assert.equal(
      (await client.callTool({ name: "graph_stats", arguments: {} })).isError,
      true,
    );
    ok(["login", "--token-stdin"], grant({ scope: "rea:runtime" }));
    assert.equal(
      (await client.callTool({ name: "graph_stats", arguments: {} })).isError,
      true,
    );
  } finally {
    t.close();
    await client.close();
    ok(["login", "--token-stdin"], grant());
  }
});

test("graph vectors retrieve a connected node without literal word overlap and readers see atomic snapshots", async () => {
  const dir = join(tmp, "snapshots"),
    one = join(tmp, "semantic.json"),
    two = join(tmp, "semantic-next.json");
  const node = (id, label) => ({
    node_id: id,
    label,
    kind: "function",
    properties: {},
    identity: { module_path: null },
  });
  const data = {
    operation: "analyze_javascript_application",
    evidence_id: "build-1",
    normalized_result: {
      semantic_graph: {
        nodes: [
          node("one", "Paginator"),
          node("two", "Chapter"),
          node("three", "Toolbar"),
        ],
        relations: [
          {
            source_node_id: "one",
            target_node_id: "two",
            relation: "reads",
            resolution: "resolved",
            relation_id: "edge-12",
          },
        ],
      },
    },
  };
  writeFileSync(one, JSON.stringify(data));
  await buildGraph(dir, one);
  const found = searchGraph(dir, "Paginator", 3, 0, "function").matches;
  assert.deepEqual(
    found.map((n) => n.id),
    ["one", "two"],
  );
  assert.ok(found[0].score > found[1].score);
  const s = sliceGraph(dir, "one", { hops: 1, budget: 500, direction: "out" });
  assert.equal(s.edges[0].relation_id, "edge-12");
  writeFileSync(two, JSON.stringify({ ...data, evidence_id: "build-2" }));
  const replace = buildGraph(dir, two);
  assert.equal(graphStats(dir).evidence_id, "build-1");
  await replace;
  assert.equal(graphStats(dir).evidence_id, "build-2");
});
