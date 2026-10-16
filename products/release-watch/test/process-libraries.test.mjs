// RW-C06 on synthetic import facts: how a module's use of a process
// library is graded by whether the import is new or only the module changed,
// and which modules changed (renamed, or content the old release shipped).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isProcessLibrary } from "../src/catalog.mjs";
import { app, at, evaluate, fact, side } from "./helpers.mjs";

const execa = (module) =>
  fact("execa", { specifier: "execa", module }, at(module, 1));
const asset = (module, sha256) => fact(module, { sha256 }, at(module, 1));

const release = (label, assets, imports) =>
  side(label, app({ assets, imports }));

const libraryFindings = (left, right, options = {}) =>
  evaluate(left, right, options).filter((finding) => finding.rule === "RW-C06");

describe("process libraries", () => {
  it("lists libraries that start processes, not other packages", () => {
    assert.ok(isProcessLibrary("execa"));
    assert.ok(isProcessLibrary("node-pty"));
    assert.equal(isProcessLibrary("axios"), false);
    assert.equal(isProcessLibrary("child_process"), false);
  });

  it("is medium when only a module that imported the library before changed", () => {
    const [finding] = libraryFindings(
      release("v1", [asset("tools.js", "a")], [execa("tools.js")]),
      release("v2", [asset("tools.js", "b")], [execa("tools.js")]),
    );
    assert.equal(finding.severity, "medium");
    assert.equal(
      finding.evidence[0].claim,
      "tools.js imports execa, as it did in v1, and changed",
    );
    assert.match(finding.unknowns[0], /imported the library before/);
  });

  it("is high when a module imports the library for the first time", () => {
    const [finding] = libraryFindings(
      release("v1", [asset("index.js", "a")], [execa("index.js")]),
      release(
        "v2",
        [asset("index.js", "a"), asset("tools.js", "c")],
        [execa("index.js"), execa("tools.js")],
      ),
    );
    assert.equal(finding.severity, "high");
    assert.deepEqual(finding.evidence.map((item) => item.claim).slice(0, -1), [
      "tools.js imports execa",
    ]);
  });

  it("follows a renamed module to the path it imported the library under", () => {
    const [finding] = libraryFindings(
      release("v1", [asset("lib/run.js", "a")], [execa("lib/run.js")]),
      release("v2", [asset("src/run.js", "b")], [execa("src/run.js")]),
      { aliases: new Map([["lib/run.js", { path: "src/run.js" }]]) },
    );
    assert.equal(finding.severity, "medium");
    assert.equal(
      finding.evidence[0].claim,
      "src/run.js imports execa, as it did in v1, and changed",
    );
  });

  it("says nothing about a module whose content the old release shipped", () => {
    assert.deepEqual(
      libraryFindings(
        release("v1", [asset("lib/run.js", "a")], [execa("lib/run.js")]),
        release("v2", [asset("src/run.js", "a")], [execa("src/run.js")]),
      ),
      [],
    );
  });

  it("says nothing about an unchanged module that imported the library before", () => {
    assert.deepEqual(
      libraryFindings(
        release("v1", [asset("tools.js", "a")], [execa("tools.js")]),
        release("v2", [asset("tools.js", "a")], [execa("tools.js")]),
      ),
      [],
    );
  });
});
