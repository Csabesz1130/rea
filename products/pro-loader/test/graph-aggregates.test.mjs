import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { graphAggregates } from "../graph/aggregates.mjs";
import { buildFreeGraph } from "../graph/index.mjs";
import { visitEvidence } from "../graph/evidence.mjs";
import { dbFile, graphStats, sliceGraph, tokens } from "../graph/store.mjs";

function fixture(extra = "", id = "one") {
  // Insertion order, escape spelling, numeric normalization and empty containers
  // all affect whether a count equals the benchmark's compact representation.
  return `{ "evidence_id":${JSON.stringify(id)}, "operation":"get_call_graph",
    "normalized_result":{"graph":{"0":[{"address":"B","status":"ok","calls":["A"]},{"address":"A","status":"ok","calls":[]}]}},
    "detail":${extra || "{}"} }`;
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "rea-count-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { store: join(dir, "store"), file: join(dir, "input.json") };
}
const expected = (text) => tokens(JSON.stringify(JSON.parse(text)));
test("compact token counts match the benchmark with chunked Unicode, escapes, formatting and reordered keys", async (t) => {
  const { file } = await setup(t);
  const texts = [
    fixture('{"z":-0,"12":"before","1":"last","z":1e+2}'),
    fixture(
      JSON.stringify(
        Array.from({ length: 16000 }, (_, n) => [
          n,
          "é中文👩🏽‍🚒 it’s 'll 🚀",
          true,
        ]),
      ),
    ),
    fixture(JSON.stringify("a \\b\n🖋️\t".repeat(20000))),
    fixture('{"s":"\\ud800x\\udc00","u":"\\ud83d\\ude00","large":1e999}'),
    fixture(JSON.stringify("'.re x9:".repeat(10000))),
  ];
  for (const text of texts) {
    await writeFile(file, text);
    assert.equal(
      (
        await visitEvidence(
          file,
          () => {},
          () => {},
        )
      ).raw_evidence_tokens,
      expected(text),
    );
  }
});
test("fixed reference counts match a real serialized slice and survive reindex/rollback/legacy reads", async (t) => {
  const { store, file } = await setup(t);
  let input = fixture();
  await writeFile(file, input);
  const stats = await buildFreeGraph(store, file);
  const sample = sliceGraph(store, "A", {
    direction: "both",
    hops: 1,
    budget: 750,
  });
  assert.deepEqual(graphAggregates(stats), {
    indexed_nodes: 2,
    indexed_edges: 1,
    raw_evidence_tokens: expected(input),
    matched_subgraph_nodes: sample.nodes.length,
    sliced_tokens_ready: tokens(JSON.stringify(sample)),
  });
  const db = new DatabaseSync(dbFile(store));
  try {
    db.prepare("UPDATE meta SET json=?").run(
      JSON.stringify({ nodes: 2, edges: 1, subject: "secret" }),
    );
  } finally {
    db.close();
  }
  assert.deepEqual(graphAggregates(graphStats(store)), {
    indexed_nodes: 2,
    indexed_edges: 1,
    raw_evidence_tokens: null,
    matched_subgraph_nodes: null,
    sliced_tokens_ready: null,
  });
  input = fixture('"more data"', "two");
  await writeFile(file, input);
  await buildFreeGraph(store, file);
  const rebuilt = graphAggregates(graphStats(store));
  assert.equal(rebuilt.raw_evidence_tokens, expected(input));
  await writeFile(file, '{"operation":');
  await assert.rejects(buildFreeGraph(store, file));
  assert.deepEqual(graphAggregates(graphStats(store)), rebuilt);
});
test("unavailable and malformed metadata has a numeric-only allowlist", () => {
  const missing = {
    indexed_nodes: null,
    indexed_edges: null,
    raw_evidence_tokens: null,
    matched_subgraph_nodes: null,
    sliced_tokens_ready: null,
  };
  assert.deepEqual(graphAggregates(), missing);
  assert.deepEqual(graphAggregates(null), missing);
  assert.deepEqual(
    graphAggregates({
      subject: "private",
      nodes: [],
      edges: -1,
      raw_evidence_tokens: {},
      matched_subgraph_nodes: 0.5,
      sliced_tokens_ready: Infinity,
    }),
    missing,
  );
});

test("large streamed Evidence produces the exact compact count for an array of containers and surrogate splits", async (t) => {
  const { file } = await setup(t);
  const row =
    '["\\ud83d\\ude00\\udc00\\n\\u0061 \\t한글",1.70e+01,{},{"0":0,"name":"we\\u0027ve"},null,false]';
  const text = fixture("[" + Array(17000).fill(row).join(", \n") + "]");
  assert.ok(Buffer.byteLength(text) > 1024 * 1024);
  await writeFile(file, text);
  assert.equal(
    (
      await visitEvidence(
        file,
        () => {},
        () => {},
      )
    ).raw_evidence_tokens,
    expected(text),
  );
});
test("unsupported measurement leaves a usable graph, and bounded keys and input limits return unknown", async (t) => {
  const { store, file } = await setup(t);
  for (const input of [
    fixture(JSON.stringify("a".repeat(2 * 1024 * 1024))),
    fixture('{"named":' + JSON.stringify("a.".repeat(560000)) + ',"4":4}'),
    fixture(
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 400 }, (_, i) => [
            String(i) + "x".repeat(3000),
            null,
          ]),
        ),
      ),
    ),
  ]) {
    await writeFile(file, input);
    const stats = await buildFreeGraph(store, file);
    assert.equal(stats.nodes, 2);
    assert.equal(stats.raw_evidence_tokens, null);
  }
  const { evidenceTokenMeter } = await import("../graph/compact-tokens.mjs");
  assert.equal(evidenceTokenMeter(512 * 1024 * 1024 + 1).finish(), null);
});
test("reference metrics stay unknown on an empty graph, an oversized identity, or an oversized graph record", async (t) => {
  const { store, file } = await setup(t);
  const native = JSON.parse(fixture());
  for (const value of [
    { ...native, normalized_result: { graph: { 0: [] } } },
    { ...native, evidence_id: "x".repeat(600) },
    {
      ...native,
      normalized_result: {
        graph: {
          0: [{ address: "A", status: "error", error: "x".repeat(9000) }],
        },
      },
    },
  ]) {
    await writeFile(file, JSON.stringify(value));
    const s = graphAggregates(await buildFreeGraph(store, file));
    assert.equal(s.matched_subgraph_nodes, null);
    assert.equal(s.sliced_tokens_ready, null);
  }
});
