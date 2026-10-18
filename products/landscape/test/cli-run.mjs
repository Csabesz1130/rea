// Runs the public Landscape CLI with the REA build in this checkout, for the
// CLI tests. `skip` (Release Watch's) is set when REA has not been built.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { skip, writeFiles } from "../../release-watch/test/cli-run.mjs";

export { skip };

const here = path.dirname(fileURLToPath(import.meta.url));
const product = path.resolve(here, "..");
const fixtures = path.join(here, "fixtures");

const read = (out, name) =>
  existsSync(path.join(out, name))
    ? readFileSync(path.join(out, name), "utf8")
    : "";

/**
 * Runs `landscape <command> ...inputs ...args --out <temp dir>`: `{ out,
 * result, report, outputs }`, with `report` null when none was written and
 * `outputs` the text of each report file by name ("" when not written).
 */
export const landscape = (command, inputs, args = []) => {
  const out = mkdtempSync(path.join(tmpdir(), "landscape-test-"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(product, "bin", "landscape.mjs"),
      command,
      ...inputs,
      ...args,
      "--out",
      out,
    ],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  const outputs = Object.fromEntries(
    ["report.json", "report.md", "report.html", "brief.md"].map((name) => [
      name,
      read(out, name),
    ]),
  );
  const json = outputs["report.json"];
  return { out, result, report: json ? JSON.parse(json) : null, outputs };
};

/** A fixture product's path. */
export const fixture = (name) => path.join(fixtures, name);

/**
 * Temporary products written from sources: `write(name, version, files)`
 * returns a directory holding `files` (path → text) and a package.json;
 * `cleanup()` removes every directory made, `keep(dir)` adds one.
 */
export const written = () => {
  const dirs = [];
  const root = mkdtempSync(path.join(tmpdir(), "landscape-written-"));
  dirs.push(root);
  return {
    write: (name, version, files) =>
      writeFiles(mkdtempSync(path.join(root, `${name}-${version}-`)), {
        "package.json": JSON.stringify({
          name,
          version,
          type: "module",
          main: "index.js",
        }),
        ...files,
      }),
    keep: (dir) => dirs.push(dir),
    cleanup: () =>
      dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
  };
};

/** The state of one product's cell in a report, by trait id and product label. */
export const cell = (report, rowId, label) => {
  const product = report.products.find(
    (candidate) => candidate.label === label,
  );
  return (
    report.rows.find((row) => row.id === rowId)?.cells[product.id].state ??
    "absent"
  );
};
