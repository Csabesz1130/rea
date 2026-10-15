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

/** Compares two releases; `{ out, result, report }`, with `report` null when none was written. */
export const run = (left, right, ...extra) => {
  const out = mkdtempSync(path.join(tmpdir(), "release-watch-test-"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(product, "bin", "release-watch.mjs"),
      "compare",
      left,
      right,
      "--out",
      out,
      "--vendor-domain",
      "acmenotes.example",
      ...extra,
    ],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  const reportFile = path.join(out, "report.json");
  const report = existsSync(reportFile)
    ? JSON.parse(readFileSync(reportFile, "utf8"))
    : null;
  return { out, result, report };
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
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), text);
      }
      return dir;
    },
    keep: (dir) => dirs.push(dir),
    cleanup: () =>
      dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
  };
};
