// swarm-args.mjs on a Landscape report written for each case: the unknown
// tool-reach cells become packages named by their package.json, known ones
// only as calibration, in batches; a product it cannot place stops it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { writeFiles } from "../../release-watch/test/cli-run.mjs";
import { swarmArgs } from "../swarm-args.mjs";

const root = mkdtempSync(path.join(tmpdir(), "vm-swarm-args-"));
after(() => rmSync(root, { recursive: true, force: true }));

const packageDir = (name, manifest) =>
  writeFiles(path.join(root, name), {
    "package.json": JSON.stringify(manifest),
  });

const dirs = {
  shell: packageDir("shell-1.0.0", {
    name: "@acme/shell-mcp",
    version: "1.0.0",
  }),
  // Landscape may name a product after its directory; package.json names it.
  unnamed: packageDir("unnamed-2.0.0", {
    name: "@acme/drawing",
    version: "2.0.0",
  }),
  known: packageDir("known-3.0.0", { name: "known-mcp", version: "3.0.0" }),
  quiet: packageDir("quiet-4.0.0", { name: "quiet-mcp", version: "4.0.0" }),
};

const report = (overrides = {}) => ({
  products: [
    { id: "p1", name: "@acme/shell-mcp", version: "1.0.0", input: dirs.shell },
    { id: "p2", name: "package", version: null, input: dirs.unnamed },
    { id: "p3", name: "known-mcp", version: "3.0.0", input: dirs.known },
    { id: "p4", name: "quiet-mcp", version: "4.0.0", input: dirs.quiet },
    ...(overrides.products ?? []),
  ],
  rows: [
    {
      id: "agent.tool-process",
      cells: {
        p1: { state: "unknown", reasons: ["it imports cross-spawn"] },
        p2: { state: "unknown", reasons: [] },
        p3: { state: "yes", notes: [] },
        p4: { state: "no", notes: [] },
      },
    },
  ],
});

const options = { claims: "/work/claims", cli: "/repo/proof-swarm.mjs" };

describe("swarm-args", () => {
  it("makes a package of every unknown cell, named by its package.json", () => {
    const args = swarmArgs(report(), Object.values(dirs), options);
    assert.equal(args.cli, "/repo/proof-swarm.mjs");
    assert.equal(args.claims, "/work/claims");
    assert.deepEqual(
      args.batches.flatMap((batch) => batch.packages),
      [
        {
          name: "@acme/shell-mcp",
          version: "1.0.0",
          dir: dirs.shell,
          slug: "acme__shell-mcp",
          reasons: ["it imports cross-spawn"],
        },
        {
          name: "@acme/drawing",
          version: "2.0.0",
          dir: dirs.unnamed,
          slug: "acme__drawing",
          reasons: [],
        },
      ],
    );
  });

  it("adds known answers as calibration and batches every package", () => {
    const args = swarmArgs(report(), Object.values(dirs), {
      ...options,
      batchSize: 2,
      calibrate: ["known-mcp", "quiet-mcp"],
    });
    assert.deepEqual(
      args.batches.map(({ id, packages }) =>
        packages.map((item) => `${id} ${item.name} ${item.calibration ?? "-"}`),
      ),
      [
        ["1 @acme/shell-mcp -", "1 @acme/drawing -"],
        ["2 known-mcp yes", "2 quiet-mcp no"],
      ],
    );
  });

  it("stops at a product outside the package list or an unknown calibration", () => {
    assert.throws(
      () =>
        swarmArgs(
          report({ products: [{ id: "p5", name: "x", input: "/elsewhere" }] }),
          Object.values(dirs),
          options,
        ),
      /\/elsewhere is not in the package list/,
    );
    assert.throws(
      () =>
        swarmArgs(report(), Object.values(dirs), {
          ...options,
          calibrate: ["@acme/shell-mcp"],
        }),
      /has no known answer/,
    );
  });
});
