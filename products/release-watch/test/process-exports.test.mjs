// Which exports of a local module hold child_process, on a synthetic import
// index: re-export chains, star re-exports, properties of a CommonJS
// module.exports, correlated names, and cycles.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { exportHolder, wholeHolder } from "../src/facts/process-exports.mjs";

const entry = (overrides = {}) => ({
  externalExports: new Map(),
  exports: new Map(),
  imported: new Map(),
  reexports: new Map(),
  stars: new Set(),
  ...overrides,
});

const traced = (specifier, form, path) => ({
  data: { specifier, form, path, imported: null },
});

const NONE = { named: () => null, namedList: () => [] };

describe("exports that hold child_process", () => {
  it("follows CommonJS re-exports to module.exports and its properties", () => {
    const modules = new Map([
      [
        "a.js",
        entry({
          externalExports: new Map([
            ["default", traced("child_process", "commonjs-export", [])],
          ]),
        }),
      ],
      [
        "b.js",
        entry({
          reexports: new Map([
            [
              "default",
              { module: "a.js", name: "default", form: "commonjs-export" },
            ],
          ]),
        }),
      ],
    ]);
    assert.equal(exportHolder(modules, "b.js", "default", NONE).member, null);
    assert.equal(
      exportHolder(modules, "b.js", "execSync", NONE).member,
      "execSync",
    );
    assert.equal(wholeHolder(modules, "b.js", NONE).commonjs, true);
  });

  it("reads a namespace through star re-exports, and no other name", () => {
    const modules = new Map([
      [
        "cp.mjs",
        entry({
          externalExports: new Map([
            ["*", traced("node:child_process", "re-export", ["*"])],
          ]),
          exports: new Map([["name", { local: "name" }]]),
        }),
      ],
      ["index.mjs", entry({ stars: new Set(["cp.mjs"]) })],
    ]);
    assert.equal(
      exportHolder(modules, "index.mjs", "spawn", NONE).member,
      "spawn",
    );
    assert.equal(exportHolder(modules, "index.mjs", "name", NONE), null);
    assert.equal(wholeHolder(modules, "index.mjs", NONE).namespace.star, true);
  });

  it("asks for a correlated name only where REA traced no export", () => {
    const guessed = { member: "spawn", heuristic: true };
    const named = (module, name) => (name === "spawn" ? guessed : null);
    const modules = new Map([
      ["spawn.js", entry({ exports: new Map([["run", { local: "runIt" }]]) })],
    ]);
    const correlated = { named, namedList: () => [] };
    assert.equal(
      exportHolder(modules, "spawn.js", "spawn", correlated).member,
      "spawn",
    );
    assert.equal(
      exportHolder(modules, "spawn.js", "spawn", correlated).heuristic,
      true,
    );
    assert.equal(
      exportHolder(modules, "spawn.js", "run", {
        named: () => guessed,
        namedList: () => [],
      }),
      null,
    );
    const whole = wholeHolder(modules, "spawn.js", {
      named,
      namedList: () => ["spawn"],
    });
    assert.equal(whole.heuristic, true);
    assert.equal(whole.namespace.names.get("spawn").member, "spawn");
  });
});

describe("exports that hold no child_process", () => {
  it("ends a re-export cycle without a holder", () => {
    const modules = new Map([
      [
        "a.js",
        entry({ reexports: new Map([["x", { module: "b.js", name: "x" }]]) }),
      ],
      [
        "b.js",
        entry({
          reexports: new Map([["x", { module: "a.js", name: "x" }]]),
          stars: new Set(["a.js"]),
        }),
      ],
    ]);
    assert.equal(exportHolder(modules, "a.js", "x", NONE), null);
    assert.equal(wholeHolder(modules, "b.js", NONE), null);
  });

  it("does not take an export REA traced to another package", () => {
    const modules = new Map([
      [
        "run.js",
        entry({
          externalExports: new Map([
            ["default", traced("execa", "commonjs-export", [])],
          ]),
        }),
      ],
    ]);
    assert.equal(wholeHolder(modules, "run.js", NONE), null);
  });
});
