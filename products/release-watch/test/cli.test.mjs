// Runs the public CLI against the fixtures with the REA build in this
// checkout. Skipped when REA has not been built.
import assert from "node:assert/strict";
import {
  cpSync,
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

import { fixtures, here, run, skip } from "./cli-run.mjs";

const FAKE_KEY = "sk-proj-DEMO-not-a-real-key-000000000000000000";

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
    const exec = finding.evidence.find((item) =>
      item.claim.startsWith("exec() creates"),
    );
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

describe("compare: a renamed component", { skip }, () => {
  let renamed;
  before(() => {
    const copy = mkdtempSync(path.join(tmpdir(), "release-watch-rename-"));
    cpSync(path.join(fixtures, "acme-notes-cloud-2.4.0"), copy, {
      recursive: true,
    });
    const manifest = JSON.parse(
      readFileSync(path.join(copy, "release-watch.json"), "utf8"),
    );
    manifest.components[0].name = "frontend";
    writeFileSync(
      path.join(copy, "release-watch.json"),
      JSON.stringify(manifest),
    );
    renamed = {
      ...run(path.join(fixtures, "acme-notes-cloud-2.3.0"), copy),
      copy,
    };
  });
  after(() => {
    rmSync(renamed.out, { recursive: true, force: true });
    rmSync(renamed.copy, { recursive: true, force: true });
  });

  it("pairs it with its old name and still compares its captures", () => {
    assert.equal(renamed.result.status, 2, renamed.result.stderr);
    assert.deepEqual(
      renamed.report.components.map((component) => [
        component.name,
        component.renamed,
      ]),
      [
        ["web → frontend", { from: "web", to: "frontend" }],
        ["api", null],
      ],
    );
    // Each side's Evidence is filed under that side's manifest name.
    const [web] = renamed.report.components;
    assert.deepEqual(
      [web.left.application.evidence_file, web.right.application.evidence_file],
      [
        "evidence/web-left-application.json",
        "evidence/frontend-right-application.json",
      ],
    );
    const rules = renamed.report.findings.map((finding) => finding.rule);
    for (const rule of ["RW-H02", "RW-H03", "RW-H04", "RW-A02"])
      assert.ok(rules.includes(rule), rule);
    assert.ok(!rules.includes("RW-C02"));
  });
});

describe("compare: MCP tools that reach process execution", { skip }, () => {
  const local = path.join(here, "fixtures");
  let reach;
  before(() => {
    reach = run(
      path.join(local, "reach-forms-1.0.0"),
      path.join(local, "reach-forms-1.1.0"),
    );
  });
  after(() => rmSync(reach.out, { recursive: true, force: true }));

  const cited = (report) =>
    report.findings
      .filter((finding) => finding.rule === "RW-M01")
      .flatMap((finding) => finding.evidence)
      .filter((item) => item.claim === "registerTool() call")
      .map((item) => `${item.location.file}:${item.location.line}`)
      .sort();

  it("follows aliased, namespace, two-hop and CommonJS imports", () => {
    assert.equal(reach.result.status, 2, reach.result.stderr);
    assert.deepEqual(cited(reach.report), [
      "src/index.js:15",
      "src/index.js:19",
      "src/index.js:23",
      "src/legacy-tool.cjs:3",
    ]);
  });

  it("does not take a local variable or a nested namesake for the function", () => {
    // src/index.js:8 calls util.js's exported log(), not compactStore's
    // nested log(); src/index.js:11 declares its own `result`, not rotate.js's.
    const lines = cited(reach.report);
    assert.ok(!lines.includes("src/index.js:8"));
    assert.ok(!lines.includes("src/index.js:11"));
    assert.ok(
      reach.report.findings
        .flatMap((finding) => finding.evidence)
        .every((item) => !/^[A-Z][a-z]+File\(\)/.test(item.claim)),
      "claims keep the method's own name",
    );
  });
});

describe(
  "compare: MCP tools reached through values and exports",
  { skip },
  () => {
    let values;
    before(() => {
      const local = path.join(here, "fixtures");
      values = run(
        path.join(local, "reach-values-1.0.0"),
        path.join(local, "reach-values-1.1.0"),
      );
    });
    after(() => rmSync(values.out, { recursive: true, force: true }));

    it("follows tool tables, handler objects, default re-exports and star exports", () => {
      assert.equal(values.result.status, 2, values.result.stderr);
      const lines = values.report.findings
        .filter((finding) => finding.rule === "RW-M01")
        .flatMap((finding) => finding.evidence)
        .filter((item) => item.claim === "registerTool() call")
        .map((item) => item.location.line)
        .sort((a, b) => a - b);
      // A tool table (18), a handler map (25), a re-exported default (33)
      // and a star export (41). Not 26, an imported logger object; 30, an
      // imported constant; or 37, a harmless anonymous default export next to
      // an exec function. The map's initializer ends before line 25 uses it.
      assert.deepEqual(lines, [18, 25, 33, 41]);
    });
  },
);

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
