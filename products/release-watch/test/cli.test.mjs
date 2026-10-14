// Runs the public CLI against the fixture app directories with the REA build
// in this checkout. Skipped when REA has not been built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const product = path.resolve(here, "..");
const fixtures = path.join(product, "demo", "fixtures");
const reaBuilt = existsSync(path.resolve(product, "../../dist/cli.js"));

describe(
  "release-watch compare",
  { skip: reaBuilt ? false : "REA is not built (npm run build:cached)" },
  () => {
    let out;
    let result;
    let report;

    before(() => {
      out = mkdtempSync(path.join(tmpdir(), "release-watch-test-"));
      result = spawnSync(
        process.execPath,
        [
          path.join(product, "bin", "release-watch.mjs"),
          "compare",
          path.join(fixtures, "acme-notes-1.4.0", "app"),
          path.join(fixtures, "acme-notes-1.5.0", "app"),
          "--out",
          out,
          "--vendor-domain",
          "acmenotes.example",
        ],
        { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
      );
      report = JSON.parse(readFileSync(path.join(out, "report.json"), "utf8"));
    });

    after(() => rmSync(out, { recursive: true, force: true }));

    it("blocks the update with exit status 2", () => {
      assert.equal(result.status, 2, result.stderr);
      assert.equal(report.verdict.decision, "block");
      assert.match(result.stdout, /BLOCK/);
    });

    it("finds the renderer-reachable exec and only that channel", () => {
      const critical = report.findings.filter(
        (finding) => finding.rule === "RW-E01",
      );
      assert.deepEqual(
        critical.map((finding) => finding.title),
        ['Renderer can reach new process execution via "diagnostics:run"'],
      );
      const exec = critical[0].evidence.find((item) =>
        /exec\(\)/.test(item.claim),
      );
      assert.equal(exec.location.file, "lib/diagnostics.js");
      assert.equal(exec.snippet.verified, true);
    });

    it("separates the third-party beacon from the first-party sync call", () => {
      const network = report.findings.filter(
        (finding) => finding.rule === "RW-N01",
      );
      const bySeverity = Object.fromEntries(
        network.map((finding) => [finding.severity, finding.title]),
      );
      assert.match(bySeverity.high, /ingest\.quickmetrics\.example\.net/);
      assert.match(bySeverity.low, /api\.acmenotes\.example/);
    });

    it("reports the sandbox regression with both versions' locations", () => {
      const sandbox = report.findings.find(
        (finding) => finding.rule === "RW-E02",
      );
      assert.deepEqual(
        sandbox.evidence.map((item) => item.location?.file),
        ["main.js", "main.js"],
      );
    });

    it("writes every REA Evidence record it cites", () => {
      for (const side of [report.left, report.right]) {
        const file = path.join(out, side.application.evidence_file);
        const evidence = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(evidence.evidence_id, side.application.evidence_id);
      }
      assert.ok(existsSync(path.join(out, "report.html")));
      assert.ok(existsSync(path.join(out, "report.md")));
    });
  },
);
