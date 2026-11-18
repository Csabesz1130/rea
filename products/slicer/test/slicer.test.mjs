// The slicer against a real REA Evidence record: test/fixtures is the
// analyze_javascript_application output for a four-line module that reads
// three credential-store paths. The tests build the index from it and run
// each query, so the index shape, the surface summary, search and the
// budgeted slice run on a producer's own output, not a hand-made graph.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { indexEvidence } from "../src/index-evidence.mjs";
import { search, slice, summary } from "../src/slice.mjs";
import { readIndex, writeIndex } from "../src/store.mjs";
import { estimateJsonTokens } from "../src/tokens.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "credentials-app.evidence.json");
const evidence = JSON.parse(readFileSync(fixture, "utf8"));

let store;
let index;
before(() => {
  store = mkdtempSync(path.join(tmpdir(), "slicer-test-"));
  writeIndex(store, indexEvidence(evidence));
  index = readIndex(store);
});
after(() => rmSync(store, { recursive: true, force: true }));

describe("indexing one Evidence record", () => {
  it("keeps the counts and drops the Evidence's bulk", () => {
    const built = indexEvidence(evidence);
    const graph = evidence.normalized_result.semantic_graph;
    assert.equal(built.meta.counts.nodes, graph.nodes.length);
    assert.equal(built.meta.counts.edges, graph.relations.length);
    assert.equal(built.meta.subject.name, "v2");
    // The summary a reader sees first is a small fraction of the Evidence.
    const whole = estimateJsonTokens(evidence);
    const front = estimateJsonTokens([built.meta, built.surface]);
    assert.ok(front * 10 < whole, `summary ${front} vs whole ${whole}`);
  });

  it("refuses an Evidence that is not an application graph", () => {
    assert.throws(
      () =>
        indexEvidence({ operation: "inspect_macho", normalized_result: {} }),
      /analyze_javascript_application/,
    );
  });
});

describe("the surface summary", () => {
  it("names the modules and the credential-store reads with their ids", () => {
    const front = summary(index);
    assert.equal(front.subject.name, "v2");
    assert.deepEqual(
      front.modules.map((module) => module.module),
      ["index.js"],
    );
    const keys = front.config_reads.items.map((read) => read.key);
    assert.ok(keys.includes("/root/.ssh/id_ed25519"), keys.join(","));
    for (const read of front.config_reads.items) {
      assert.match(read.id, /^jsrg_node_/);
      assert.equal(read.module, "index.js");
    }
  });
});

describe("search", () => {
  it("finds a node by a word in its label or a kept property value", () => {
    const result = search(index, "kube");
    const literal = result.matches.find((node) => node.kind === "literal");
    assert.ok(literal, JSON.stringify(result));
    assert.equal(literal.properties.value, "~/.kube/config");
    assert.equal(literal.at, "index.js:6");
  });

  it("falls back to a substring when the lexicon has no whole word", () => {
    // ".ssh" is not a whole word; the scan still finds the config path.
    const result = search(index, ".ssh/id_ed25519");
    assert.ok(result.total >= 1, JSON.stringify(result));
    assert.ok(
      result.matches.some((node) =>
        JSON.stringify(node).includes("id_ed25519"),
      ),
    );
  });

  it("returns nothing for a term in no node", () => {
    assert.deepEqual(search(index, "nonesuchtoken").matches, []);
  });
});

describe("slice", () => {
  it("returns the neighbourhood of a node with the edges among it", () => {
    const literal = search(index, "kube").matches.find(
      (node) => node.kind === "literal",
    );
    const result = slice(index, literal.id, { hops: 2 });
    assert.equal(result.root.id, literal.id);
    assert.ok(result.nodes.some((node) => node.hops === 0));
    // Every edge joins two nodes the slice kept.
    const ids = new Set(result.nodes.map((node) => node.id));
    for (const edge of result.edges) {
      assert.ok(ids.has(edge.source));
      assert.ok(ids.has(edge.target));
    }
    assert.equal(result.truncated, false);
  });

  it("keeps the node payload within the budget, nearest first", () => {
    const literal = search(index, "kube").matches.find(
      (node) => node.kind === "literal",
    );
    const full = slice(index, literal.id, { hops: 3, budget: 5000 });
    const tight = slice(index, literal.id, { hops: 3, budget: 60 });
    assert.ok(tight.nodes.length < full.nodes.length);
    assert.ok(tight.nodes_tokens <= 60, `nodes_tokens ${tight.nodes_tokens}`);
    assert.equal(tight.truncated, true);
    // The root is always first and always kept.
    assert.equal(tight.nodes[0].id, literal.id);
    assert.equal(tight.nodes[0].hops, 0);
  });

  it("reports an error for a node id the index does not hold", () => {
    assert.match(slice(index, "jsrg_node_absent").error, /no node has the id/);
  });
});

describe("the store", () => {
  it("builds adjacency in both directions over the edges", () => {
    let both = 0;
    for (const [, sides] of index.adjacency)
      both += sides.out.length + sides.in.length;
    // Every edge is reachable from each of its endpoints.
    assert.equal(both, index.edges.length * 2);
  });
});
