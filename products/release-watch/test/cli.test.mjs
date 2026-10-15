// Runs the public CLI against the fixtures with the REA build in this
// checkout. Skipped when REA has not been built.
import assert from "node:assert/strict";
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
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const product = path.resolve(here, "..");
const fixtures = path.join(product, "demo", "fixtures");
const reaBuilt = existsSync(path.resolve(product, "../../dist/cli.js"));
const skip = reaBuilt ? false : "REA is not built (npm run build:cached)";
const FAKE_KEY = "sk-proj-DEMO-not-a-real-key-000000000000000000";

const run = (left, right, ...extra) => {
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

const titles = (report, rule) =>
  report.findings
    .filter((finding) => finding.rule === rule)
    .map((finding) => finding.title);

describe("compare: Electron app directories", { skip }, () => {
  let run1;
  before(() => {
    run1 = run(
      path.join(fixtures, "acme-notes-1.4.0", "app"),
      path.join(fixtures, "acme-notes-1.5.0", "app"),
    );
  });
  after(() => rmSync(run1.out, { recursive: true, force: true }));

  it("blocks the update with exit status 2", () => {
    assert.equal(run1.result.status, 2, run1.result.stderr);
    assert.equal(run1.report.verdict.decision, "block");
    assert.match(run1.result.stdout, /BLOCK/);
  });

  it("finds the renderer-reachable exec and only that channel", () => {
    assert.deepEqual(titles(run1.report, "RW-E01"), [
      'Renderer can reach new process execution via "diagnostics:run"',
    ]);
    const finding = run1.report.findings.find(
      (candidate) => candidate.rule === "RW-E01",
    );
    const exec = finding.evidence.find((item) => /exec\(\)/.test(item.claim));
    assert.equal(exec.location.file, "lib/diagnostics.js");
    assert.equal(exec.snippet.verified, true);
  });

  it("separates the third-party beacon from the first-party sync call", () => {
    const bySeverity = Object.fromEntries(
      run1.report.findings
        .filter((finding) => finding.rule === "RW-N01")
        .map((finding) => [finding.severity, finding.title]),
    );
    assert.match(bySeverity.high, /ingest\.quickmetrics\.example\.net/);
    assert.match(bySeverity.low, /api\.acmenotes\.example/);
  });

  it("writes every REA Evidence record it cites", () => {
    const [component] = run1.report.components;
    for (const side of [component.left, component.right]) {
      const evidence = JSON.parse(
        readFileSync(
          path.join(run1.out, side.application.evidence_file),
          "utf8",
        ),
      );
      assert.equal(evidence.evidence_id, side.application.evidence_id);
    }
    assert.ok(existsSync(path.join(run1.out, "report.html")));
    assert.ok(existsSync(path.join(run1.out, "report.md")));
  });
});

describe("compare: web and API release with captures", { skip }, () => {
  let run2;
  before(() => {
    run2 = run(
      path.join(fixtures, "acme-notes-cloud-2.3.0"),
      path.join(fixtures, "acme-notes-cloud-2.4.0"),
    );
  });
  after(() => rmSync(run2.out, { recursive: true, force: true }));

  it("reviews both components from the manifest", () => {
    assert.equal(run2.result.status, 2, run2.result.stderr);
    assert.equal(run2.report.product, "Acme Notes Cloud");
    assert.deepEqual(run2.report.labels, { left: "v2.3.0", right: "v2.4.0" });
    assert.deepEqual(
      run2.report.components.map((component) => [
        component.name,
        component.surfaces,
      ]),
      [
        ["web", ["web", "ai"]],
        ["api", ["ai", "mcp"]],
      ],
    );
  });

  it("finds the browser-shipped key, the browser credential and the MCP exec tool", () => {
    const critical = run2.report.findings
      .filter((finding) => finding.severity === "critical")
      .map((finding) => finding.rule);
    assert.deepEqual(critical.sort(), ["RW-A02", "RW-H03", "RW-M01"]);
  });

  it("reports web, runtime and AI changes", () => {
    assert.deepEqual(titles(run2.report, "RW-W01"), [
      "New third-party script: cdn.quickmetrics.example.net",
    ]);
    assert.deepEqual(titles(run2.report, "RW-N01"), [
      "New third-party destination: collect.quickmetrics.example.net",
    ]);
    assert.deepEqual(titles(run2.report, "RW-A01"), [
      "Browser code calls OpenAI directly (api.openai.com)",
    ]);
    assert.equal(
      run2.report.findings.find((finding) => finding.rule === "RW-H02")
        .severity,
      "high",
    );
    assert.deepEqual(titles(run2.report, "RW-H04"), [
      "Cookie session lost HttpOnly, SameSite=Lax",
    ]);
    assert.deepEqual(titles(run2.report, "RW-A04"), [
      "Prompt text changed: SYSTEM_PROMPT in src/summarize.js",
    ]);
    assert.equal(
      titles(run2.report, "RW-N02").length,
      0,
      "service worker pass-through requests are not unresolved destinations",
    );
  });

  it("never writes the shipped key into a report file", () => {
    for (const file of ["report.json", "report.md", "report.html"])
      assert.ok(
        !readFileSync(path.join(run2.out, file), "utf8").includes(FAKE_KEY),
        `${file} contains the key`,
      );
  });

  it("pairs renamed bundles through REA and content-hash names", () => {
    const [web] = run2.report.components;
    assert.deepEqual(web.module_aliases.map((alias) => alias.basis).sort(), [
      "REA exact-module-source-digest",
      "same bundle name without content hash",
    ]);
  });
});

describe("compare: captures only and nothing to analyze", { skip }, () => {
  const outs = [];
  after(() =>
    outs.forEach((out) => rmSync(out, { recursive: true, force: true })),
  );

  it("compares two HAR captures on their own", () => {
    const { out, result, report } = run(
      path.join(fixtures, "acme-notes-cloud-2.3.0", "web.har"),
      path.join(fixtures, "acme-notes-cloud-2.4.0", "web.har"),
    );
    outs.push(out);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(report.findings.map((finding) => finding.rule).sort(), [
      "RW-A01",
      "RW-H02",
      "RW-H03",
      "RW-H04",
      "RW-N01",
      "RW-N01",
    ]);
  });

  it("fails closed when a release holds nothing REA can analyze", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "release-watch-empty-"));
    mkdirSync(path.join(empty, "a"));
    mkdirSync(path.join(empty, "b"));
    writeFileSync(path.join(empty, "a", "notes.txt"), "not an app\n");
    const { out, result, report } = run(
      path.join(empty, "a"),
      path.join(empty, "b"),
    );
    outs.push(out, empty);
    assert.equal(result.status, 1);
    assert.equal(report.verdict.decision, "error");
    assert.equal(report.errors.length, 2);
  });
});
