// One comparison of two unpacked releases with Release Watch, as a child
// process with its own heap and a time limit, so that a comparison that
// fails or hangs costs the run one entry and nothing else.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_WATCH = fileURLToPath(
  new URL("../../release-watch/bin/release-watch.mjs", import.meta.url),
);
const KILL_GRACE_MS = 5000;

// The comparisons running now. Each is its own process group, so that a
// time limit can end it with the REA processes it started; for the same
// reason a signal to this process does not reach them by itself.
const running = new Set();

// Ends the comparison and the REA processes it started: they share its
// process group.
const endGroup = (child) => {
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      // The group is gone.
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref();
};

/** Ends every comparison still running, as when this process is told to stop. */
export const endComparisons = () => {
  for (const child of running) endGroup(child);
};

/**
 * Compares the releases unpacked at `oldDir` and `newDir` into the report
 * directory `out` (emptied first): `{ ok: true, report }` with Release
 * Watch's report.json, also when Release Watch could analyze only part of
 * a release (its verdict then says so); or `{ ok: false, reason, detail }`
 * with reason "timeout" (after `timeoutMs`) or "compare-failed". `heapMb`
 * is the Node heap of Release Watch and of the REA processes it starts;
 * `depth` is Release Watch's ("standard" or "deep").
 */
export const compareReleases = ({
  oldDir,
  newDir,
  out,
  heapMb,
  timeoutMs,
  depth = "standard",
}) =>
  new Promise((resolve) => {
    rmSync(out, { recursive: true, force: true });
    const child = spawn(
      process.execPath,
      [
        RELEASE_WATCH,
        "compare",
        oldDir,
        newDir,
        "--out",
        out,
        "--fail-on",
        "never",
        "--depth",
        depth,
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          NO_COLOR: "1",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--max-old-space-size=${heapMb}`,
        },
      },
    );
    running.add(child);
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      endGroup(child);
    }, timeoutMs);
    child.on("error", (error) => {
      running.delete(child);
      clearTimeout(timer);
      resolve({ ok: false, reason: "compare-failed", detail: error.message });
    });
    child.on("close", (code) => {
      running.delete(child);
      clearTimeout(timer);
      if (timedOut)
        return resolve({
          ok: false,
          reason: "timeout",
          detail: `the comparison ran past ${Math.round(timeoutMs / 60000)} minutes`,
        });
      const file = path.join(out, "report.json");
      if (existsSync(file))
        try {
          return resolve({
            ok: true,
            report: JSON.parse(readFileSync(file, "utf8")),
          });
        } catch (error) {
          return resolve({
            ok: false,
            reason: "compare-failed",
            detail: `report.json is not JSON: ${error.message}`,
          });
        }
      const last = Buffer.concat(stderr)
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .at(-1);
      return resolve({
        ok: false,
        reason: "compare-failed",
        detail:
          last ??
          `Release Watch exited with status ${code} and wrote no report`,
      });
    });
  });
