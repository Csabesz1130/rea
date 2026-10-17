// The analysis settings Release Watch resolves from --depth, the limit
// options and --jobs, the REA options it passes for them, what RW-C01
// recommends from the limits REA reached, and how the coverage gaps count
// the files REA could not analyze.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffApplications } from "../src/diff.mjs";
import { coverageOf } from "../src/report/coverage.mjs";
import {
  DEPTHS,
  analysisRecord,
  analysisSettings,
  reaAnalysisArguments,
  rerunWith,
} from "../src/limits.mjs";
import { app, at, evaluate, fact, side } from "./helpers.mjs";

describe("analysis settings", () => {
  it("uses the standard preset when nothing is given", () => {
    const settings = analysisSettings({});
    assert.equal(settings.depth, "standard");
    assert.equal(settings.jobs, DEPTHS.standard.jobs);
    assert.deepEqual(settings.explicit, []);
    assert.deepEqual(reaAnalysisArguments(settings), [
      "--max-semantic-nodes",
      String(DEPTHS.standard.maxSemanticNodes),
      "--max-semantic-nodes-per-file",
      String(DEPTHS.standard.maxSemanticNodesPerFile),
      "--max-heap-mb",
      String(DEPTHS.standard.maxHeapMb),
    ]);
  });

  it("lets each given option replace one value of the preset", () => {
    const settings = analysisSettings({
      depth: "deep",
      "max-semantic-nodes-per-file": "1234",
      jobs: "2",
    });
    assert.deepEqual(analysisRecord(settings), {
      depth: "deep",
      max_semantic_nodes: DEPTHS.deep.maxSemanticNodes,
      max_semantic_nodes_per_file: 1234,
      max_heap_mb: DEPTHS.deep.maxHeapMb,
      jobs: 2,
      explicit: ["--max-semantic-nodes-per-file", "--jobs"],
    });
    const standard = analysisSettings({ "max-heap-mb": "512" });
    assert.equal(standard.maxHeapMb, 512);
    assert.equal(standard.maxSemanticNodes, DEPTHS.standard.maxSemanticNodes);
  });

  it("analyzes one side at a time at the deep depth unless --jobs says otherwise", () => {
    assert.equal(analysisSettings({ depth: "deep" }).jobs, 1);
    assert.equal(analysisSettings({ depth: "deep", jobs: "2" }).jobs, 2);
    assert.equal(analysisSettings({ jobs: "1" }).jobs, 1);
    assert.equal(analysisSettings({}).jobs, 2);
  });

  it("raises both node limits at the deep depth", () => {
    for (const key of ["maxSemanticNodes", "maxSemanticNodesPerFile"])
      assert.ok(DEPTHS.deep[key] > DEPTHS.standard[key], key);
    assert.ok(
      DEPTHS.deep.maxSemanticNodesPerFile <= DEPTHS.deep.maxSemanticNodes,
    );
  });

  it("rejects unknown depths, jobs and limits that are not positive whole numbers", () => {
    assert.throws(
      () => analysisSettings({ depth: "shallow" }),
      /--depth must be one of standard, deep/,
    );
    assert.throws(
      () => analysisSettings({ jobs: "3" }),
      /--jobs must be 1 or 2/,
    );
    for (const value of ["0", "-5", "1.5", "1e6", " 10", ""])
      assert.throws(
        () => analysisSettings({ "max-semantic-nodes": value }),
        /--max-semantic-nodes must be a positive whole number/,
        value,
      );
  });
});

describe("re-run advice for the limits REA reached", () => {
  it("offers the deep depth only for a reached limit it raises and the caller did not set", () => {
    const standard = analysisSettings({});
    const DEEP = `--depth deep (up to ${DEPTHS.deep.maxSemanticNodes} semantic nodes, ${DEPTHS.deep.maxSemanticNodesPerFile} in one file)`;
    assert.deepEqual(rerunWith(standard, ["maxSemanticNodes"]), {
      deep: true,
      text: DEEP,
    });
    assert.deepEqual(rerunWith(undefined, ["maxSemanticNodesPerFile"]), {
      deep: true,
      text: DEEP,
    });
    assert.equal(
      rerunWith(analysisSettings({ depth: "deep" }), ["maxSemanticNodes"]).deep,
      false,
    );
    assert.deepEqual(
      rerunWith(analysisSettings({ "max-semantic-nodes-per-file": "50" }), [
        "maxSemanticNodesPerFile",
      ]),
      {
        deep: false,
        text: "higher --max-semantic-nodes-per-file than this run's 50",
      },
    );
  });

  it("states the limits a deep re-run would use with the caller's own options", () => {
    const rerun = (values, reached) =>
      rerunWith(analysisSettings(values), reached).text;
    const perFile = ["maxSemanticNodesPerFile"];
    // A given global limit stays in force at the deep depth.
    assert.equal(
      rerun({ "max-semantic-nodes": "400000" }, perFile),
      `--depth deep (up to 400000 semantic nodes, ${DEPTHS.deep.maxSemanticNodesPerFile} in one file)`,
    );
    assert.equal(
      rerun({ "max-semantic-nodes-per-file": "50000" }, ["maxSemanticNodes"]),
      `--depth deep (up to ${DEPTHS.deep.maxSemanticNodes} semantic nodes, 50000 in one file)`,
    );
    // A file's nodes count toward the global limit, which bounds it.
    assert.equal(
      rerun({ "max-semantic-nodes-per-file": "300000" }, ["maxSemanticNodes"]),
      `--depth deep (up to ${DEPTHS.deep.maxSemanticNodes} semantic nodes, ${DEPTHS.deep.maxSemanticNodes} in one file)`,
    );
    // @notionhq/notion-mcp-server with --max-semantic-nodes 130000: deep
    // raises the per-file limit, but the given global limit still binds.
    assert.equal(
      rerun({ "max-semantic-nodes": "130000" }, [
        "maxSemanticNodesPerFile",
        "maxSemanticNodes",
      ]),
      "--depth deep and a higher --max-semantic-nodes than this run's 130000 (a limit given as an option replaces the depth's)",
    );
    // Below the per-file limit, the given global limit is the one reached.
    assert.equal(
      rerun({ "max-semantic-nodes": "100000" }, [
        "maxSemanticNodesPerFile",
        "maxSemanticNodes",
      ]),
      "higher --max-semantic-nodes than this run's 100000",
    );
  });
});

describe("RW-C01 recommendation from the limits REA reached", () => {
  const bundle = (sha256) =>
    fact("vendor/bundle.js", { sha256 }, at("vendor/bundle.js", 1));
  // v2 changed vendor/bundle.js, and REA truncated its analysis as `coverage` says.
  const recommendation = (coverage, values = {}, old = app()) => {
    const truncated = app({ assets: [bundle("b")] });
    truncated.coverage = {
      ...truncated.coverage,
      semantic_truncated: true,
      ...coverage,
    };
    old.assets = [bundle("a")];
    const [finding] = evaluate(side("v1", old), side("v2", truncated), {
      options: { analysis: analysisSettings(values) },
    });
    assert.equal(finding.rule, "RW-C01");
    return finding.recommendation;
  };
  const DEEP = `--depth deep (up to ${DEPTHS.deep.maxSemanticNodes} semantic nodes, ${DEPTHS.deep.maxSemanticNodesPerFile} in one file)`;
  const ceiling = { semantic_ceiling_modules: ["vendor/bundle.js"] };

  it("recommends the deep preset for a node limit of the standard preset", () => {
    for (const coverage of [
      ceiling,
      { semantic_global_limit_reached: true },
      { semantic_unreached_modules: ["vendor/bundle.js"] },
    ])
      assert.equal(
        recommendation(coverage),
        `Re-run with ${DEEP}, or review the listed files by other means.`,
      );
  });

  it("recommends raising the reached limit when the deep preset would not", () => {
    const higher = (options) =>
      `Re-run with higher ${options}, or review the listed files by other means.`;
    assert.equal(
      recommendation(ceiling, { depth: "deep" }),
      higher(
        `--max-semantic-nodes-per-file than this run's ${DEPTHS.deep.maxSemanticNodesPerFile}`,
      ),
    );
    assert.equal(
      recommendation(ceiling, { "max-semantic-nodes-per-file": "50" }),
      higher("--max-semantic-nodes-per-file than this run's 50"),
    );
    assert.equal(
      recommendation(
        { semantic_global_limit_reached: true },
        { depth: "deep" },
      ),
      higher(
        `--max-semantic-nodes than this run's ${DEPTHS.deep.maxSemanticNodes}`,
      ),
    );
    // The analyzer's heap, not a node limit, cut the analysis short: the
    // coverage facts name no node limit, so every limit option is named.
    assert.equal(
      recommendation({
        semantic_limits: [
          "javascript_analysis_worker_heap_limit_bytes 1098907648 bytes",
        ],
      }),
      higher(
        `--max-semantic-nodes, --max-semantic-nodes-per-file or --max-heap-mb than this run's ${DEPTHS.standard.maxSemanticNodes}, ${DEPTHS.standard.maxSemanticNodesPerFile} and ${DEPTHS.standard.maxHeapMb}`,
      ),
    );
  });

  it("still offers the deep preset for a file REA could not examine before either", () => {
    const old = app({
      analysisFailures: [
        fact(
          "failure",
          { code: "resource_constraint" },
          at("vendor/bundle.js", 1),
        ),
      ],
    });
    assert.equal(
      recommendation(ceiling, {}, old),
      `REA could not examine these files in v1 either, so higher limits may not help; re-run with ${DEEP} to find out, or review them by other means.`,
    );
  });
});

describe("coverage of files REA could not analyze", () => {
  it("counts a file REA recorded several failures for once", () => {
    // At the deep depth REA rejected swagger-ui-dist's bundles on its result
    // budget, recording a semantic and a relationship failure for some.
    const failure = (file, message) =>
      fact("failure", { code: "resource_constraint", message }, at(file, 1));
    const rejected = app({
      analysisFailures: [
        failure("swagger-ui.js", "Semantic graph exceeds the budget"),
        failure("swagger-ui-es-bundle.js", "Semantic analysis not started"),
        failure("swagger-ui-es-bundle.js", "Relationships exceed the budget"),
        fact("failure", { code: "resource_constraint" }),
      ],
    });
    const { right } = coverageOf({
      left: side("v1", app()),
      right: side("v2", rejected),
    });
    assert.deepEqual(right.gaps, ["REA could not analyze 3 file(s)."]);
    // RW-C01 names each failed file once, with every failure REA gave it.
    const bundle = (file, sha256) => fact(file, { sha256 }, at(file, 1));
    rejected.assets = [
      bundle("swagger-ui.js", "b"),
      bundle("swagger-ui-es-bundle.js", "c"),
    ];
    const old = app({
      assets: [
        bundle("swagger-ui.js", "a"),
        bundle("swagger-ui-es-bundle.js", "d"),
      ],
    });
    const finding = evaluate(side("v1", old), side("v2", rejected), {
      options: { analysis: analysisSettings({}) },
    }).find((item) => item.rule === "RW-C01");
    assert.deepEqual(
      finding.evidence
        .map((item) => item.claim)
        .filter((claim) => claim.startsWith("REA could not analyze")),
      [
        "REA could not analyze swagger-ui.js: resource_constraint Semantic graph exceeds the budget",
        "REA could not analyze swagger-ui-es-bundle.js: resource_constraint Semantic analysis not started; resource_constraint Relationships exceed the budget",
        "REA could not analyze a file: resource_constraint",
      ],
    );
  });
});

describe("imports of an old file REA reported none for", () => {
  // At the deep depth REA rejected the old swagger-ui.js's expanded
  // relationships on its result budget: a failure and no import edges.
  const imports = (module, specifiers) =>
    specifiers.map((specifier) =>
      fact(specifier, { specifier, module }, at(module, 1)),
    );
  const run = (oldFailures) => {
    const old = app({
      analysisFailures: oldFailures,
      imports: imports("index.js", ["react"]),
      modules: new Map([
        [
          "index.js",
          {
            local: new Set(),
            externalImports: new Set(["react"]),
            unresolvedSites: [],
          },
        ],
      ]),
    });
    const now = app({
      imports: [
        ...imports("index.js", ["react"]),
        ...imports("swagger-ui.js", [
          "swagger-client/es/resolver",
          "immutable",
        ]),
        ...imports("report.js", ["left-pad"]),
      ],
    });
    const findings = evaluate(side("v1", old), side("v2", now));
    return findings.find((finding) => finding.rule === "RW-D01");
  };
  const rejected = fact(
    "failure",
    {
      code: "resource_constraint",
      message:
        "Expanded application relationships for swagger-ui.js exceed the parent's result budget",
    },
    at("swagger-ui.js", 1),
  );

  it("does not call what that file imports now new", () => {
    const finding = run([rejected]);
    assert.equal(
      finding.title,
      "New third-party packages imported (1): left-pad",
    );
    assert.equal(
      finding.summary,
      "v2 imports 1 package that no module of the old release imported; it also imports 2 packages in files whose imports REA's graph does not report for v1, so whether they are new is unknown.",
    );
    assert.ok(
      finding.unknowns.includes(
        "REA recorded a failure and no import relationship for swagger-ui.js in v1, so what it imported is unknown and the packages imported there in v2 were not compared.",
      ),
    );
    // Without that failure the old swagger-ui.js imported nothing.
    assert.equal(
      run([]).title,
      "New third-party packages imported (3): swagger-client, immutable, left-pad",
    );
  });

  it("marks those imports not compared in the inventory", () => {
    const old = app({
      analysisFailures: [rejected],
    });
    const now = app({
      imports: [
        ...imports("swagger-ui.js", ["immutable"]),
        ...imports("report.js", ["left-pad"]),
      ],
    });
    const statuses = Object.fromEntries(
      diffApplications(old, now).imports.map((item) => [item.key, item.status]),
    );
    assert.deepEqual(statuses, {
      immutable: "not-compared",
      "left-pad": "added",
    });
    // The same holds the other way: an old import of a file whose new
    // relationships REA rejected is not gone.
    const back = Object.fromEntries(
      diffApplications(
        app({ imports: imports("swagger-ui.js", ["immutable"]) }),
        app({ analysisFailures: [rejected] }),
      ).imports.map((item) => [item.key, item.status]),
    );
    assert.deepEqual(back, { immutable: "not-compared" });
  });
});
