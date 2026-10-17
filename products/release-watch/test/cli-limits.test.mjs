// Runs the public CLI on small written releases for the REA limits it
// passes: the standard preset by default, the deep preset with --depth deep,
// a given limit option over either, and what RW-C01 recommends when a given
// limit truncates. REA's Evidence records the limits it received.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { DEPTHS } from "../src/limits.mjs";
import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const PKG = { type: "module", main: "index.js" };

// Enough syntax that a per-file limit of 50 semantic nodes truncates it.
const app = (greeting) => ({
  "index.js": Array.from(
    { length: 20 },
    (_, index) =>
      `export function step${index}(value) {\n  const next = value + ${index};\n  return { next, text: "${greeting} " + next };\n}\n`,
  ).join(""),
});

const compare = (...args) => {
  const result = run(
    written.write("1.0.0", app("hello"), PKG),
    written.write("1.1.0", app("hi"), PKG),
    ...args,
  );
  written.keep(result.out);
  return result;
};

// The limits REA reports receiving, per side, from its saved Evidence.
const reaLimits = (out) =>
  ["left", "right"].map((side) => {
    const { parameters } = JSON.parse(
      readFileSync(
        path.join(out, "evidence", `app-${side}-application.json`),
        "utf8",
      ),
    );
    return [
      parameters.max_semantic_nodes,
      parameters.max_semantic_nodes_per_file,
      parameters.max_heap_mb,
    ];
  });

const coverageFinding = (report) =>
  report.findings.find((finding) => finding.rule === "RW-C01");

describe("compare: REA analysis limits", { skip }, () => {
  it("passes the standard preset to REA when no limit is given", () => {
    const { result, out, report } = compare();
    assert.equal(result.status, 0, result.stderr);
    const { standard } = DEPTHS;
    const expected = [
      standard.maxSemanticNodes,
      standard.maxSemanticNodesPerFile,
      standard.maxHeapMb,
    ];
    assert.deepEqual(reaLimits(out), [expected, expected]);
    assert.deepEqual(report.run.analysis, {
      depth: "standard",
      max_semantic_nodes: standard.maxSemanticNodes,
      max_semantic_nodes_per_file: standard.maxSemanticNodesPerFile,
      max_heap_mb: standard.maxHeapMb,
      jobs: 2,
      explicit: [],
    });
  });

  it("lets a given limit win over the deep preset and recommends raising it", () => {
    const { result, out, report } = compare(
      "--depth",
      "deep",
      "--max-semantic-nodes-per-file",
      "50",
    );
    assert.equal(result.status, 2, result.stderr);
    const expected = [DEPTHS.deep.maxSemanticNodes, 50, DEPTHS.deep.maxHeapMb];
    assert.deepEqual(reaLimits(out), [expected, expected]);
    assert.equal(report.run.analysis.jobs, 1);
    assert.deepEqual(report.run.analysis.explicit, [
      "--max-semantic-nodes-per-file",
    ]);
    const finding = coverageFinding(report);
    assert.equal(finding.severity, "high");
    assert.match(
      finding.recommendation,
      /^Re-run with higher --max-semantic-nodes-per-file than this run's 50, or review/,
    );
    // The same limit given at the standard depth: --depth deep would not
    // raise it, so it is not recommended.
    const standard = compare("--max-semantic-nodes-per-file", "50");
    assert.equal(standard.report.run.analysis.depth, "standard");
    assert.match(
      coverageFinding(standard.report).recommendation,
      /^Re-run with higher --max-semantic-nodes-per-file/,
    );
  });

  it("rejects an unknown depth before running REA", () => {
    const { result, report } = compare("--depth", "shallow");
    assert.equal(result.status, 1);
    assert.equal(report, null);
    assert.match(result.stderr, /--depth must be one of standard, deep/);
  });
});

describe(
  "compare: what REA left unexamined in the old release",
  { skip },
  () => {
    it("keeps an old file the global limit left without facts unknown, not absent", () => {
      // index.js takes v1.0.0's 500 nodes, so REA gives the old util.js no
      // semantic facts; v1.1.0 ships util.js unchanged and a new report.js,
      // both running npm.
      const steps = (count) =>
        Array.from(
          { length: count },
          (_, index) =>
            `export function step${index}(value) {\n  const next = value + ${index};\n  return { next, text: "hello " + next };\n}\n`,
        ).join("");
      const npm = (name) =>
        `import { exec } from "node:child_process";\nexport function ${name}() {\n  return new Promise((resolve) => exec("npm --version", (error, stdout) => resolve(String(stdout))));\n}\n`;
      const result = run(
        written.write(
          "1.0.0",
          {
            "index.js": `import { npmVersion } from "./util.js";\n${steps(60)}`,
            "util.js": npm("npmVersion"),
          },
          PKG,
        ),
        written.write(
          "1.1.0",
          {
            "index.js": `import { npmVersion } from "./util.js";\nimport { report } from "./report.js";\n${steps(30)}`,
            "util.js": npm("npmVersion"),
            "report.js": npm("report"),
          },
          PKG,
        ),
        "--max-semantic-nodes",
        "500",
      );
      written.keep(result.out);
      const { report } = result;
      const [component] = report.components;
      assert.deepEqual(
        component.left.application.coverage.semantic_unreached_modules,
        ["util.js"],
      );
      assert.ok(
        component.coverage.left.gaps.includes(
          "1 script file(s) with no semantic facts after REA's global node limit: util.js.",
        ),
        component.coverage.left.gaps.join("\n"),
      );
      const execIn = (file) =>
        report.findings.find(
          (finding) =>
            finding.rule === "RW-P01" &&
            finding.evidence.some((item) => item.location?.file === file),
        );
      assert.ok(
        execIn("util.js").unknowns.includes(
          "REA gave no semantic facts to util.js in v1.0.0, so what is reported here may predate this release.",
        ),
        execIn("util.js").unknowns.join("\n"),
      );
      assert.ok(
        execIn("report.js").unknowns.some((text) =>
          text.startsWith(
            "REA gave no semantic facts to 1 other file of v1.0.0 (util.js) and reached its global node limit there",
          ),
        ),
        execIn("report.js").unknowns.join("\n"),
      );
    });
  },
);
