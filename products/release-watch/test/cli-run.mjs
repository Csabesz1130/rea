// Runs the public Release Watch CLI with the REA build in this checkout, for
// the CLI tests. `skip` is set when REA has not been built.
import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
const product = path.resolve(here, "..");
export const fixtures = path.join(product, "demo", "fixtures");
const reaBuilt = existsSync(path.resolve(product, "../../dist/cli.js"));
export const skip = reaBuilt
  ? false
  : "REA is not built (npm run build:cached)";

/**
 * Runs `compare` with `args` after the two releases and `--out out`:
 * `{ out, result, report, outputs }`, with `report` null when none was
 * written and `outputs` the text of report.json, report.md and report.html
 * ("" for a file not written).
 */
export const compareCli = (left, right, { out, args = [] }) => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(product, "bin", "release-watch.mjs"),
      "compare",
      left,
      right,
      "--out",
      out,
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  const read = (name) =>
    existsSync(path.join(out, name))
      ? readFileSync(path.join(out, name), "utf8")
      : "";
  const json = read("report.json");
  return {
    out,
    result,
    report: json ? JSON.parse(json) : null,
    outputs: [json, read("report.md"), read("report.html")],
  };
};

/** Compares two releases into a new temporary directory, with the demo's vendor domain. */
export const run = (left, right, ...extra) =>
  compareCli(left, right, {
    out: mkdtempSync(path.join(tmpdir(), "release-watch-test-")),
    args: ["--vendor-domain", "acmenotes.example", ...extra],
  });

/** Writes `files` (path → text) under `root`, creating directories; returns `root`. */
export const writeFiles = (root, files) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
};

/**
 * Temporary releases written from sources: `write(version, files, pkg)`
 * returns a release directory holding `files` (path → text) and a
 * package.json; `cleanup()` removes every directory made.
 */
export const releases = () => {
  const dirs = [];
  const root = mkdtempSync(path.join(tmpdir(), "release-watch-written-"));
  dirs.push(root);
  return {
    write: (version, files, pkg = {}) => {
      const dir = mkdtempSync(path.join(root, `${version}-`));
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "written", version, ...pkg }),
      );
      return writeFiles(dir, files);
    },
    keep: (dir) => dirs.push(dir),
    cleanup: () =>
      dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
  };
};
