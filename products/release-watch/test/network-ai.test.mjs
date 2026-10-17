// Fact projections the network and AI rules read, on synthetic REA facts:
// the file an asset node names, what REA left unexamined in an app, and
// what RW-N02 advises for an old file REA could not analyze.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unexaminedIn } from "../src/facts/coverage.mjs";
import { modulePathOf } from "../src/facts/modules.mjs";
import { app, at, evaluate, fact, range, side } from "./helpers.mjs";

describe("asset paths", () => {
  it("reads an asset's file from the observation that names it, not the first", () => {
    const node = {
      kind: "javascript-asset",
      node_id: "asset",
      observations: [
        {
          label: "process-id validation candidate",
          properties: { fact_kind: "sender-validation-candidate" },
        },
        {
          label: "dist/client/_nuxt/ooe3njda.js",
          properties: { path: "dist/client/_nuxt/ooe3njda.js" },
        },
      ],
    };
    assert.equal(modulePathOf(node), "dist/client/_nuxt/ooe3njda.js");
  });
});

describe("unexamined files", () => {
  it("names each file REA did not fully examine with why, and its global limit", () => {
    const old = app({
      coverage: {
        ...app().coverage,
        semantic_ceiling_modules: ["dist/index.js"],
        semantic_unreached_modules: ["dist/index.js", "dist/chunk.js"],
        semantic_global_limit_reached: true,
      },
      analysisFailures: [
        fact("failure:1", { code: "parse-failed" }, at("dist/broken.js", 1)),
      ],
    });
    const { files, anyFile } = unexaminedIn(old);
    assert.deepEqual(
      [...files],
      [
        ["dist/index.js", "ceiling"],
        ["dist/chunk.js", "unreached"],
        ["dist/broken.js", "failed"],
      ],
    );
    assert.equal(anyFile, true);
    assert.deepEqual(unexaminedIn(null), { files: new Map(), anyFile: false });
  });
});

describe("RW-N02 for an old file REA could not analyze", () => {
  it("names no limit to raise, since none stopped REA there", () => {
    const fetchAt = (line) =>
      fact(
        "a.js#fetch",
        {
          module: "a.js",
          method: "fetch",
          endpoint: null,
          range: range(line, 0, line, 9),
        },
        at("a.js", line),
      );
    const asset = (sha256) => fact("a.js", { sha256 }, at("a.js", 1));
    const failure = fact("failure", { code: "parser_error" }, at("a.js", 1));
    const [finding] = evaluate(
      side(
        "v1",
        app({
          requests: [fetchAt(2)],
          analysisFailures: [failure],
          assets: [asset("a")],
        }),
      ),
      side(
        "v2",
        app({ requests: [fetchAt(2), fetchAt(9)], assets: [asset("b")] }),
      ),
    );
    assert.equal(finding.rule, "RW-N02");
    assert.match(finding.summary, /REA could not fully analyze a\.js in v1/);
    assert.equal(
      finding.recommendation,
      "Capture the release's traffic or ask the vendor for the destination; REA could not analyze the old code, which higher limits do not change.",
    );
  });
});
