import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffKeyed, moduleAliases } from "../src/diff.mjs";
import { app, fact } from "./helpers.mjs";

describe("diffKeyed", () => {
  it("reports one-sided facts as added only when the other side's coverage is complete", () => {
    const right = [fact("a", {})];
    assert.equal(
      diffKeyed([], right, { leftComplete: true, rightComplete: true })[0]
        .status,
      "added",
    );
    assert.equal(
      diffKeyed([], right, { leftComplete: false, rightComplete: true })[0]
        .status,
      "not-previously-observed",
    );
    assert.equal(
      diffKeyed(right, [], { leftComplete: true, rightComplete: false })[0]
        .status,
      "no-longer-observed",
    );
  });

  it("keeps duplicate keys ambiguous instead of pairing by order", () => {
    const items = diffKeyed(
      [fact("w", { x: 1 })],
      [fact("w", { x: 1 }), fact("w", { x: 2 })],
      {
        leftComplete: true,
        rightComplete: true,
        unique: true,
      },
    );
    assert.equal(items[0].status, "ambiguous");
  });
});

describe("moduleAliases", () => {
  const assets = (...paths) =>
    paths.map((modulePath) => fact(modulePath, { sha256: modulePath }));

  it("prefers REA's pairing, then pairs content-hashed bundle names", () => {
    const left = app({
      assets: assets("assets/index-4f9Kq2Lm.js", "assets/editor-Bx81LmQa.js"),
    });
    const right = app({
      assets: assets("assets/index-9pQe1VxR.js", "assets/editor-Kc72PwZd.js"),
    });
    const aliases = moduleAliases(left, right, [
      {
        left: "assets/editor-Bx81LmQa.js",
        right: "assets/editor-Kc72PwZd.js",
        basis: "exact-module-source-digest",
      },
    ]);
    assert.deepEqual(aliases.get("assets/editor-Bx81LmQa.js"), {
      path: "assets/editor-Kc72PwZd.js",
      basis: "REA exact-module-source-digest",
    });
    assert.equal(
      aliases.get("assets/index-4f9Kq2Lm.js").path,
      "assets/index-9pQe1VxR.js",
    );
  });

  it("does not treat a renamed source file as a hashed bundle", () => {
    const aliases = moduleAliases(
      app({ assets: assets("src/report-generator.js") }),
      app({ assets: assets("src/report-exporter.js") }),
    );
    assert.equal(aliases.size, 0);
  });
});
