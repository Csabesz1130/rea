import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { queryGraph, tokens } from "../graph/store.mjs";

const cli = fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url));
const fixture = fileURLToPath(
  new URL(
    "../../slicer/test/fixtures/credentials-app.evidence.json",
    import.meta.url,
  ),
);
const exec = promisify(execFile);
const lockedKeys = [
  "status",
  "indexed_nodes",
  "raw_evidence_tokens",
  "sliced_tokens_ready",
  "matched_subgraph_nodes",
  "upgrade_command",
].sort();
function assertLocked(value, count = 47, command = "rea pro login") {
  assert.deepEqual(Object.keys(value).sort(), lockedKeys);
  assert.equal(value.status, "LICENSE_REQUIRED");
  assert.equal(value.upgrade_command, command);
  assert.equal(value.indexed_nodes, count);
  for (const key of lockedKeys.filter(
    (k) => !["status", "upgrade_command"].includes(k),
  )) {
    assert.ok(
      value[key] === null ||
        (Number.isSafeInteger(value[key]) && value[key] >= 0),
      key,
    );
  }
}
async function setup(t) {
  const tmp = await mkdtemp(join(tmpdir(), "rea-lifetime-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const store = join(tmp, "store"),
    home = join(tmp, "profile");
  const env = {
    ...process.env,
    REA_PRO_HOME: home,
    REA_PRO_CONFIG: join(tmp, "local-issuer.json"),
  };
  const { publicKey } = generateKeyPairSync("ed25519");
  await writeFile(
    env.REA_PRO_CONFIG,
    JSON.stringify({
      issuer: "https://local.example.test",
      public_key: publicKey.export({ type: "spki", format: "pem" }),
    }),
  );
  const cliArgs = (args) =>
    exec(process.execPath, [cli, "pro", ...args], { env });
  const run = async (argv) =>
    JSON.parse((await cliArgs([...argv, "--store", store])).stdout);
  const raw = async (argv) => JSON.parse((await cliArgs(argv)).stdout);
  const connect = async () => {
    const client = new Client({ name: "trial-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "pro", "mcp", "--store", store],
        env,
        stderr: "pipe",
      }),
    );
    t.after(() => client.close());
    return {
      client,
      call: async (name, args) => {
        const res = await client.callTool({ name, arguments: args });
        assert.ok(!res.isError, JSON.stringify(res));
        return JSON.parse(res.content[0].text);
      },
    };
  };
  return {
    home,
    tmp,
    store,
    run,
    raw,
    cliArgs,
    connect,
    configPath: env.REA_PRO_CONFIG,
  };
}
test("three full queries survive restarts; the fourth and all probes expose only aggregates", async (t) => {
  const { tmp, store, run, raw, cliArgs, connect } = await setup(t);
  await run(["index", fixture]);
  const { client, call } = await connect();
  const names = (await client.listTools()).tools.map((o) => o.name).sort();
  assert.deepEqual(names, ["graph_search", "graph_slice", "graph_stats"]);
  const bad = await client.callTool({
    name: "graph_slice",
    arguments: { id: "unknown-before-trial" },
  });
  assert.equal(bad.isError, true);
  const hit = await run(["search", "kube", "--kind", "function"]);
  const id = hit.matches[0].id;
  const firstSlice = await call("graph_slice", { id, hops: 1, budget: 500 });
  assert.ok(firstSlice.nodes.length > 1);
  assert.ok(tokens(JSON.stringify(firstSlice)) <= 500);
  assert.deepEqual(
    await run(["slice", id, "--hops", "1", "--budget", "500"]),
    firstSlice,
  );
  const locked = await run(["search", "kube"]);
  assertLocked(locked);
  for (const [name, input] of [
    ["graph_search", { query: "A_SECRET_SYMBOL" }],
    ["graph_stats", {}],
    ["graph_slice", { id, hops: 1 }],
    ["graph_slice", { id: "no-such-node", evidence_id: "bad-evidence" }],
    ["graph_slice", { id, budget: "PRIVATE_INPUT" }],
    ["graph_stats", { PRIVATE_KEY: true }],
  ]) {
    assert.deepEqual(await call(name, input), locked);
  }
  assert.deepEqual(await run(["stats"]), locked);
  assert.deepEqual(await run(["slice", id, "--bogus-sensitive-flag"]), locked);
  const missing = await raw([
    "slice",
    "secret",
    "--store",
    join(tmp, "secret-missing"),
  ]);
  assertLocked(missing, null);
  assert.deepEqual(await run(["index", fixture]), locked);
  const fail = await cliArgs([
    "index",
    join(tmp, "PRIVATE_MISSING_FILE"),
    "--store",
    store,
  ]);
  assert.ok(!fail.stderr.includes("PRIVATE_MISSING_FILE"));
  assertLocked(JSON.parse(fail.stdout));
});
test("only three simultaneous successful CLI requests return full graph metadata", async (t) => {
  const { run } = await setup(t);
  await run(["index", fixture]);
  const values = await Promise.all(
    Array.from({ length: 7 }, () => run(["stats"])),
  );
  assert.equal(values.filter((v) => v.evidence_id).length, 3);
  const denied = values.filter((v) => v.status === "LICENSE_REQUIRED");
  assert.equal(denied.length, 4);
  denied.forEach((v) => assertLocked(v));
});
test("migration charges every retained legacy day once, never resets, and repeated successes count", async (t) => {
  const { home, run, store } = await setup(t);
  await mkdir(home, { recursive: true });
  const legacy = new DatabaseSync(join(home, "preview-usage.sqlite"));
  legacy.exec(
    "CREATE TABLE slices(day TEXT,fingerprint TEXT,PRIMARY KEY(day,fingerprint)) WITHOUT ROWID; INSERT INTO slices VALUES('2020-01-01','same'),('2020-01-02','same')",
  );
  legacy.close();
  await run(["index", fixture]);
  const plan = queryGraph(store, (db) =>
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM nodes WHERE json_extract(data,'$.label') COLLATE BINARY=? ORDER BY id",
      )
      .all("kube"),
  );
  assert.ok(plan.some((p) => p.detail.includes("exact_labels")));
  const response = await run(["search", "kube", "--mode", "exact"]);
  assert.equal(response.matches[0].label, "kube");
  assertLocked(await run(["search", "kube", "--mode", "exact"]));
});
test("trial semantic lookup retrieves a related function without a direct term match", async (t) => {
  const { tmp, run } = await setup(t),
    path = join(tmp, "graph.json");
  const node = (id, label) => ({
    node_id: id,
    label,
    kind: "function",
    properties: {},
    identity: { module_path: null },
  });
  await writeFile(
    path,
    JSON.stringify({
      operation: "analyze_javascript_application",
      evidence_id: "small",
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
              relation_id: "edge",
            },
          ],
        },
      },
    }),
  );
  await run(["index", path]);
  const exact = await run(["search", "Paginator"]);
  assert.deepEqual(
    exact.matches.map((n) => n.id),
    ["one"],
  );
  const ranked = await run(["search", "Paginator", "--mode", "semantic"]);
  assert.deepEqual(
    ranked.matches.map((n) => n.id),
    ["one", "two"],
  );
});

test("index-only and exhausted exports expose no symbols and preserve existing files", async (t) => {
  const { tmp, store, cliArgs, run } = await setup(t);
  const src = join(tmp, "PRIVATE_APP");
  await mkdir(src);
  await writeFile(
    join(src, "PRIVATE_SYMBOL.js"),
    "export function PRIVATE_APP_SYMBOL(){return 7;}\n",
  );
  const build = (args) =>
    cliArgs(["index-bundle", src, "--store", store, ...args]);
  const output = join(tmp, "original.json");
  const first = await build([]);
  assert.ok(JSON.parse(first.stdout).indexed_nodes > 0);
  assert.doesNotMatch(first.stdout + first.stderr, /PRIVATE_/);
  await writeFile(output, "retain-me");
  await assert.rejects(build(["--evidence-out", output]));
  assert.equal(await readFile(output, "utf8"), "retain-me");
  const exported = join(tmp, "export.json");
  await build(["--evidence-out", exported]);
  assert.ok(JSON.parse(await readFile(exported, "utf8")).evidence_id);
  assert.ok((await run(["stats"])).evidence_id);
  assert.ok((await run(["stats"])).evidence_id);
  const fresh = join(tmp, "blocked.json");
  const after = await build(["--evidence-out", fresh]);
  const locked = JSON.parse(after.stdout);
  assert.ok(locked.indexed_nodes > 0);
  assertLocked(locked, locked.indexed_nodes);
  assert.doesNotMatch(after.stdout + after.stderr, /PRIVATE_/);
  await assert.rejects(stat(fresh), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(tmp)).filter((name) => name.startsWith(".rea-evidence-")),
    [],
  );
  const existing = await build(["--evidence-out", output]);
  assertLocked(JSON.parse(existing.stdout), locked.indexed_nodes);
  assert.equal(await readFile(output, "utf8"), "retain-me");
});

test("commercial accounts have independent lifetimes on one machine; an outage reveals no local result", async (t) => {
  const { tmp, home, store, run } = await setup(t);
  await run(["index", fixture]);
  for (let i = 0; i < 3; i++) assert.equal((await run(["stats"])).nodes, 47);
  assertLocked(await run(["stats"]));
  const cfgPath = join(tmp, "commercial.json"),
    issuer = "https://api.realizations.ai";
  const keys = generateKeyPairSync("ed25519");
  await writeFile(
    cfgPath,
    JSON.stringify({
      issuer,
      trial_endpoint: issuer + "/trial",
      public_key: keys.publicKey.export({ type: "spki", format: "pem" }),
    }),
  );
  const old = Object.fromEntries(
    ["REA_PRO_CONFIG", "REA_PRO_HOME"].map((k) => [k, process.env[k]]),
  );
  const oldFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = oldFetch;
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  process.env.REA_PRO_CONFIG = cfgPath;
  process.env.REA_PRO_HOME = home;
  const { login } = await import("../auth.mjs");
  const { trialQuery } = await import("../graph/preview.mjs");
  const counts = new Map();
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const activate = async (sub) => {
    const unsigned =
      encode({ alg: "EdDSA" }) +
      "." +
      encode({
        iss: issuer,
        aud: "rea-account",
        scope: "rea:account",
        sub,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    const token =
      unsigned +
      "." +
      sign(null, Buffer.from(unsigned), keys.privateKey).toString("base64url");
    await login({ trial: true, token });
    return token;
  };
  let outage = false,
    decline = false;
  globalThis.fetch = async (url, opts) => {
    assert.equal(String(url), issuer + "/trial");
    if (outage) throw new Error("outage");
    const token = opts.headers.authorization.slice("Bearer ".length);
    const count = counts.get(token) ?? 0;
    if (opts.method === "GET") return Response.json({ remaining: 3 - count });
    assert.deepEqual(Object.keys(JSON.parse(opts.body)), ["request_id"]);
    const granted = !decline && count < 3;
    if (granted) counts.set(token, count + 1);
    return Response.json({ granted });
  };
  const attempt = () =>
    trialQuery(store, () => ({ symbol: "commercial-success" }));
  const one = await activate("one");
  for (let i = 0; i < 3; i++)
    assert.equal((await attempt()).symbol, "commercial-success");
  assert.equal(counts.get(one), 3);
  assertLocked(await attempt(), 47, "npx @realizations/rea login");
  const two = await activate("two");
  decline = true;
  assertLocked(await attempt(), 47, "npx @realizations/rea login");
  assert.ok(!counts.has(two));
  decline = false;
  assert.equal((await attempt()).symbol, "commercial-success");
  assert.equal(counts.get(two), 1);
  outage = true;
  let observed = false;
  const locked = await trialQuery(store, () => {
    observed = true;
    return { secret: true };
  });
  assert.equal(observed, false);
  assertLocked(locked, 47, "npx @realizations/rea login");
});

test("fresh MCP denies a fourth exact lookup and a one-hop repeat with identical aggregate JSON", async (t) => {
  const { run, connect } = await setup(t);
  await run(["index", fixture]);
  const { call } = await connect();
  const first = await call("graph_search", { query: "kube", kind: "function" });
  const id = first.matches[0].id;
  const neighborhood = { id, hops: 1, budget: 500 };
  assert.ok((await call("graph_slice", neighborhood)).edges.length);
  assert.equal((await call("graph_stats", {})).nodes, 47);
  const locked = await call("graph_search", { query: "kube" });
  assertLocked(locked);
  assert.deepEqual(await call("graph_slice", neighborhood), locked);
});
