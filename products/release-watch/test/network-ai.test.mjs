// Fact projections the network and AI rules read, on synthetic REA facts:
// the file an asset node names, and what REA left unexamined in an app.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unexaminedIn } from "../src/facts/coverage.mjs";
import { modulePathOf } from "../src/facts/modules.mjs";
import { app, at, fact } from "./helpers.mjs";

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
