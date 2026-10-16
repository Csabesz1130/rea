// Export resolution on a synthetic import index: the rules reach,
// destination attribution and process gaps share (facts/exports.mjs).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { exportedNames, resolveExport } from "../src/facts/exports.mjs";

const entry = (overrides = {}) => ({
  externalExports: new Map(),
  exports: new Map(),
  imported: new Map(),
  reexports: new Map(),
  stars: new Set(),
  ...overrides,
});

// The caller's own definition: the module and name, for any name.
const own = (module, name, exported) => ({ module, name, exported });

describe("export resolution", () => {
  it("never gives default through export *", () => {
    const modules = new Map([
      ["barrel.js", entry({ stars: new Set(["handlers.js"]) })],
      [
        "handlers.js",
        entry({ exports: new Map([["default", { local: null }]]) }),
      ],
    ]);
    const none = () => null;
    assert.deepEqual(resolveExport(modules, "barrel.js", "default", none), {
      unknown: "barrel.js",
    });
    assert.deepEqual(exportedNames(modules, "barrel.js"), []);
  });

  it("takes a name from the first star module that defines it, and a module's own export first", () => {
    const modules = new Map([
      [
        "index.js",
        entry({
          stars: new Set(["a.js", "b.js"]),
          exports: new Map([["mine", { local: "mine" }]]),
        }),
      ],
      ["a.js", entry({ exports: new Map([["run", { local: "run" }]]) })],
      ["b.js", entry({ exports: new Map([["run", { local: "go" }]]) })],
    ]);
    const found = resolveExport(modules, "index.js", "run", (module, name) =>
      module === "index.js" ? null : own(module, name),
    );
    assert.equal(found.defined.module, "a.js");
    assert.deepEqual(found.through, ["index.js", "a.js"]);
    assert.equal(
      resolveExport(modules, "index.js", "mine", own).defined.module,
      "index.js",
    );
  });
});

describe("export resolution beyond what REA names", () => {
  it("follows a CommonJS module.exports = require() to the module it re-exports", () => {
    const modules = new Map([
      [
        "tools.js",
        entry({
          exports: new Map([["default", { local: null }]]),
          reexports: new Map([
            [
              "default",
              { module: "git.js", name: "default", form: "commonjs-export" },
            ],
          ]),
        }),
      ],
      ["git.js", entry({ exports: new Map([["runGit", { local: null }]]) })],
      [
        "esm.js",
        entry({
          reexports: new Map([
            [
              "default",
              { module: "git.js", name: "default", form: "re-export" },
            ],
          ]),
        }),
      ],
    ]);
    const found = resolveExport(modules, "tools.js", "runGit", own);
    assert.equal(found.defined.module, "git.js");
    assert.deepEqual(found.through, ["tools.js", "git.js"]);
    assert.equal(found.guessed, undefined);
    // `export { default } from` re-exports only default.
    assert.equal(
      resolveExport(modules, "esm.js", "runGit", () => null).unknown,
      "esm.js",
    );
  });

  it("matches a name REA reports no export for to a binding, following an import", () => {
    const modules = new Map([
      [
        "b.js",
        entry({
          exports: new Map([["default", { local: null }]]),
          imported: new Map([["spawn", { module: "a.js", name: "spawn" }]]),
        }),
      ],
      ["a.js", entry({ exports: new Map([["default", { local: null }]]) })],
    ]);
    const found = resolveExport(modules, "b.js", "spawn", own);
    assert.equal(found.defined.module, "a.js");
    assert.equal(found.defined.exported, undefined);
    assert.deepEqual(found.guessed, { module: "b.js", name: "spawn" });
  });

  it("gives an external module's export, a property of its module.exports, and ends cycles", () => {
    const site = (form, path) => ({
      data: { specifier: "child_process", form, path },
    });
    const modules = new Map([
      [
        "cp.js",
        entry({
          externalExports: new Map([["default", site("commonjs-export", [])]]),
        }),
      ],
      [
        "x.js",
        entry({ reexports: new Map([["y", { module: "y.js", name: "y" }]]) }),
      ],
      [
        "y.js",
        entry({ reexports: new Map([["y", { module: "x.js", name: "y" }]]) }),
      ],
    ]);
    const whole = resolveExport(modules, "cp.js", "default", own);
    assert.equal(whole.property, null);
    assert.equal(
      resolveExport(modules, "cp.js", "execSync", own).property,
      "execSync",
    );
    assert.equal(resolveExport(modules, "x.js", "y", own).unknown, "x.js");
  });
});
