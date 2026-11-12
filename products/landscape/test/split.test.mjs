// The demo's split of a large package into components: which files a
// component holds, what a skipped directory and a test file leave out, and
// the manifest Release Watch reads the components from.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { split } from "../demo/split.mjs";

const work = mkdtempSync(path.join(tmpdir(), "landscape-split-"));
after(() => rmSync(work, { recursive: true, force: true }));

// A package directory holding `files` (path to text) under `name`.
const packageOf = (name, files) => {
  const directory = path.join(work, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
  }
  return directory;
};

const source = packageOf("agent", {
  "package.json": JSON.stringify({
    name: "@example/agent",
    version: "1.2.3",
    type: "module",
  }),
  "dist/cli.js": "export const cli = 1;\n",
  "dist/cli.d.ts": "export declare const cli: number;\n",
  "dist/core/loop.js": "export const loop = 1;\n",
  "dist/core/loop.test.js": "export const tested = 1;\n",
  "dist/core/tools/shell.mjs": "export const shell = 1;\n",
  "dist/bundle/all.js": "export const all = 1;\n",
  "dist/types/only.d.ts": "export type Only = 1;\n",
});

describe("split", () => {
  it("lays one component per directory and one for the loose files", () => {
    const out = path.join(work, "whole");
    const made = split(source, out, { root: "dist" });
    assert.deepEqual(
      { ...made, out: undefined },
      {
        out: undefined,
        product: "@example/agent",
        version: "1.2.3",
        components: 3,
        files: 4,
      },
    );
    const manifest = JSON.parse(
      readFileSync(path.join(out, "release-watch.json"), "utf8"),
    );
    assert.equal(manifest.product, "@example/agent");
    assert.deepEqual(manifest.components.map((item) => item.name).sort(), [
      "bundle",
      "core",
      "top-level",
    ]);
    // A file keeps its path under the root, so a report names it as shipped.
    assert.ok(existsSync(path.join(out, "core/core/tools/shell.mjs")));
    assert.ok(existsSync(path.join(out, "core/core/loop.js")));
    assert.ok(existsSync(path.join(out, "top-level/cli.js")));
    // A test file ships with the package and does not run with the product.
    assert.ok(!existsSync(path.join(out, "core/core/loop.test.js")));
    // A directory without a script file is no component.
    assert.ok(!existsSync(path.join(out, "types")));
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(out, "core/package.json"), "utf8")),
      { name: "@example/agent/core", version: "1.2.3", type: "module" },
    );
  });

  it("leaves a skipped directory out and replaces an earlier split", () => {
    const out = path.join(work, "whole");
    const made = split(source, out, { root: "dist", skip: ["bundle"] });
    assert.equal(made.components, 2);
    assert.equal(made.files, 3);
    assert.ok(!existsSync(path.join(out, "bundle")));
  });

  it("returns null when the root holds no script file", () => {
    assert.equal(
      split(source, path.join(work, "none"), { root: "dist/types" }),
      null,
    );
    assert.equal(
      split(source, path.join(work, "absent"), { root: "build" }),
      null,
    );
  });
});
