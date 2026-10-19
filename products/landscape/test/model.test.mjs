// Map, opening and trajectory semantics the CLI tests do not reach cheaply:
// counts over unknown cells, a change across a release REA examined only in
// part, and openings that depend on how many products a map holds.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { trajectory } from "../src/history.mjs";
import { mapRows, summarize } from "../src/map.mjs";
import { openings } from "../src/opportunities.mjs";
import { TRAITS } from "../src/traits/definitions.mjs";

const complete = { status: "complete", components: [] };
const partial = {
  status: "partial",
  components: [
    { name: "app", status: "partial", files: ["a.js"], reason: null },
  ],
};

// A product holding `held` trait definitions, REA's coverage as given.
const product = (id, held, coverage = complete) => ({
  id,
  role: "competitor",
  label: id,
  coverage,
  traits: {
    held: new Map(
      held.map((definition) => [
        definition.id,
        {
          ...definition,
          strength: "yes",
          evidence: [],
          evidence_count: 0,
          values: [],
        },
      ]),
    ),
    unknown: new Map(),
    notes: new Map(),
  },
});

describe("map counts", () => {
  it("counts a product REA examined in part as unknown, not as lacking the trait", () => {
    const products = [
      product("p1", [TRAITS.process]),
      product("p2", [TRAITS.process]),
      product("p3", [TRAITS.process]),
      product("p4", [], partial),
    ];
    const [row] = mapRows(products, products);
    assert.equal(row.cells.p4.state, "unknown");
    assert.match(
      row.cells.p4.reasons[0],
      /REA examined 1 file of this product only in part/,
    );
    assert.deepEqual(row.counts, {
      yes: 3,
      likely: 0,
      no: 0,
      unknown: 1,
      held: 3,
    });
    const summary = summarize([row], products);
    assert.deepEqual(
      summary.common.map((found) => found.id),
      ["system.process"],
    );
  });

  it("names a capability one product shows only when three or more are compared", () => {
    const two = [product("p1", [TRAITS.terminal]), product("p2", [])];
    assert.deepEqual(summarize(mapRows(two, two), two).distinct, []);
    const three = [...two, product("p3", [])];
    const [only] = summarize(mapRows(three, three), three).distinct;
    assert.equal(only.product.id, "p1");
  });
});

describe("openings", () => {
  it("suggests serving MCP tools only when two or more products serve none", () => {
    const pair = [product("p1", [TRAITS.process]), product("p2", [])];
    assert.deepEqual(
      openings(mapRows(pair, pair), 2).map((opening) => opening.id),
      ["agent-ready"],
    );
    const one = [product("p1", [TRAITS.process])];
    assert.deepEqual(openings(mapRows(one, one), 1), []);
  });
});

describe("trajectory", () => {
  it("places a change across a release REA examined in part between the releases around it", () => {
    const versions = [
      product("p1", [TRAITS.telemetry]),
      product("p2", [], partial),
      product("p3", []),
    ];
    const rows = mapRows(versions, versions);
    assert.deepEqual(trajectory(rows, versions), {
      changes: [
        {
          row: "data.telemetry",
          kind: "disappeared",
          version: "p3",
          since: "p1",
          adjacent: false,
        },
      ],
      present: [{ row: "data.telemetry", version: "p1" }],
    });
  });
});
