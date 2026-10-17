// Runs the public CLI on small releases each test writes, for where a
// module uses child_process and REA classified no process call: which
// values REA ties to child_process, which reads a classified call accounts
// for, and process libraries REA does not model.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const compare = (before, after) => {
  const result = run(
    written.write("1.0.0", before),
    written.write("1.1.0", after),
  );
  written.keep(result.out);
  return result;
};

const OLD = { "index.js": 'exports.status = () => "ok";\n' };

// The RW-C01 evidence lines located in `file`.
const gapLines = (report, file) =>
  report.findings
    .filter((finding) => finding.rule === "RW-C01")
    .flatMap((finding) => finding.evidence)
    .filter((item) => item.location?.file === file);

// Asserts an RW-C01 line at `file:line` whose claim matches `claim`.
const assertGap = (report, [file, line], claim, basis = "derived") => {
  const lines = gapLines(report, file);
  assert.ok(
    lines.some(
      (item) =>
        item.location.line === line &&
        item.basis === basis &&
        claim.test(item.claim),
    ),
    JSON.stringify(lines),
  );
};

describe("compare: child_process uses REA did not classify", { skip }, () => {
  it("reports each unclassified use of a child_process binding, and no name that is not one", () => {
    const { result, report } = compare(OLD, {
      ...OLD,
      // promisify(exec): REA reports no process call for plain exec.
      "diag.js":
        'const { exec } = require("child_process");\nconst { promisify } = require("util");\nconst execAsync = promisify(exec);\nexports.run = async (cmd) => (await execAsync(cmd)).stdout;\n',
      // A classified execFile must not hide a second, unclassified one.
      "git.js":
        'const cp = require("child_process");\nconst { promisify } = require("util");\nconst execFileAsync = promisify(cp.execFile);\nexports.status = () => cp.execFile("git", ["status"]);\nexports.sh = (c) => execFileAsync("sh", ["-c", c]);\n',
      // Names that are not child_process: a saga effect, a game method,
      // RegExp.prototype.exec.
      "sagas.js":
        'const { all, fork } = require("redux-saga/effects");\nfunction* watch() { yield 1; }\nexports.root = function* root() { yield all([fork(watch)]); };\n',
      "game.js": 'exports.wave = (world) => world.spawn("enemy");\n',
      "match.js": "exports.first = (re, s) => re.exec(s);\n",
    });
    assert.equal(result.status, 2, result.stderr);
    assertGap(
      report,
      ["diag.js", 3],
      /^REA did not resolve the call to which diag\.js passes exec \(exec is imported from child_process\)/,
    );
    assertGap(
      report,
      ["git.js", 3],
      /^REA classified no process call where git\.js reads cp\.execFile \(cp is imported from child_process\)/,
    );
    // The classified git call is RW-P01, not a coverage gap.
    assert.ok(
      report.findings.some(
        (finding) =>
          finding.rule === "RW-P01" &&
          finding.title === "New process execution: execFile() in git.js",
      ),
    );
    assert.deepEqual(
      gapLines(report, "git.js").map((item) => item.location.line),
      [3],
    );
    for (const file of ["sagas.js", "game.js", "match.js"])
      assert.deepEqual(gapLines(report, file), [], file);
  });

  it("passes a changed saga that forks a watcher", () => {
    const saga = (load) =>
      `import { all, fork, takeEvery } from "redux-saga/effects";\nfunction* ${load}() { yield 1; }\nfunction* watchSync() { yield 2; }\nexport default function* root() { yield all([takeEvery("notes/load", ${load}), fork(watchSync)]); }\n`;
    const { result, report } = compare(
      { "src/sagas.js": saga("loadNotes") },
      { "src/sagas.js": saga("loadAllNotes") },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(report.findings, []);
  });
});

describe("compare: values that hold child_process", { skip }, () => {
  it("follows child_process through an assignment and an interop wrapper", () => {
    const importStar =
      'var __importStar = function (mod) { if (mod && mod.__esModule) return mod; var result = {}; for (var k in mod) result[k] = mod[k]; result["default"] = mod; return result; };\n';
    const { result, report } = compare(OLD, {
      ...OLD,
      // TypeScript's esModuleInterop output.
      "compiled.js": `"use strict";\n${importStar}const cp = __importStar(require("child_process"));\nexports.run = (c) => (0, cp.exec)(c);\n`,
      "lazy.js":
        'let cp;\nexports.run = (c) => { cp = require("child_process"); return cp.execSync(c); };\n',
    });
    assert.equal(result.status, 2, result.stderr);
    assertGap(
      report,
      ["compiled.js", 4],
      /^REA classified no process call where compiled\.js calls cp\.exec \(Release Watch takes cp to hold child_process: it is assigned a call on require\("child_process"\)\)$/,
      "heuristic",
    );
    assertGap(
      report,
      ["lazy.js", 2],
      /^REA classified no process call where lazy\.js calls cp\.execSync \(cp is assigned require\("child_process"\)\)$/,
    );
  });

  it("follows computed members on aliases, require calls and nested keys, and says whether they are called", () => {
    const { result, report } = compare(OLD, {
      ...OLD,
      "table.js":
        'const cp = require("child_process");\nconst METHODS = { shell: "exec", file: "execFile" };\nexports.run = (kind, c) => cp[METHODS[kind]](c);\n',
      "alias.js":
        'const cp = require("child_process");\nconst proc = cp;\nexports.run = (m, c) => proc[m](c);\n',
      "inline.js": 'exports.run = (m, c) => require("child_process")[m](c);\n',
      "probe.js":
        'const cp = require("child_process");\nexports.has = (names) => names.filter((name) => typeof cp[name] === "function");\n',
    });
    assert.equal(result.status, 2, result.stderr);
    assertGap(
      report,
      ["table.js", 3],
      /^REA could not resolve the computed member name table\.js calls on cp \(cp is imported from child_process\), so that process call is not classified$/,
    );
    // REA does not link `const proc = cp` to cp: Release Watch's correlation.
    assertGap(
      report,
      ["alias.js", 3],
      /^REA could not resolve the computed member name alias\.js calls on proc \(Release Watch takes proc to hold child_process: REA reports it defined right before a read of cp and gives its value no other source\)/,
      "heuristic",
    );
    assertGap(
      report,
      ["inline.js", 1],
      /^REA could not resolve the computed member name inline\.js calls on require\("child_process"\)/,
    );
    // A read that is never called is not claimed as a call.
    assertGap(
      report,
      ["probe.js", 2],
      /^REA could not resolve the computed member name probe\.js reads on cp \(cp is imported from child_process\), so a process call through it may not be classified$/,
    );
  });
});

describe(
  "compare: reads of child_process that hold or call nothing",
  { skip },
  () => {
    it("reports a guard read on child_process itself, and a read in an IIFE as a read", () => {
      const { result, report } = compare(OLD, {
        ...OLD,
        // No parameter, string constant or derived flag holds child_process.
        "guard.js":
          'const cp = require("child_process");\nfunction clean(text) {\n  if (!cp) return null;\n  return text.trim();\n}\nexports.clean = clean;\nexports.ok = (name) => cp !== undefined && name.length > 0;\n',
        "flag.js":
          'const cp = require("child_process");\nconst version = "1.0";\nconst ready = typeof cp === "object";\nexports.v = (k) => (ready ? version : k);\n',
        // esbuild and UMD output: the module body is an IIFE.
        "iife.js":
          '(() => {\n  const cp = require("child_process");\n  exports.has = (name) => typeof cp[name] === "function";\n  exports.run = (c) => cp.execSync(c);\n})();\n',
      });
      assert.equal(result.status, 2, result.stderr);
      const unused =
        /^REA's graph does not show how (guard|flag)\.js uses cp \(cp is imported from child_process\), so a process call through it may not be classified$/;
      for (const [file, lines] of [
        ["guard.js", [3, 7]],
        ["flag.js", [3]],
      ]) {
        for (const line of lines) assertGap(report, [file, line], unused);
        assert.deepEqual(
          gapLines(report, file).map((item) => item.location.line),
          lines,
        );
      }
      assertGap(
        report,
        ["iife.js", 3],
        /^REA could not resolve the computed member name iife\.js reads on cp \(cp is imported from child_process\), so a process call through it may not be classified$/,
      );
      assertGap(
        report,
        ["iife.js", 4],
        /^REA classified no process call where iife\.js calls cp\.execSync \(cp is imported from child_process\)$/,
      );
    });
  },
);

describe("compare: process libraries REA does not model", { skip }, () => {
  it("blocks a module that newly runs commands through execa, and skips one that only moved", () => {
    const describeModule =
      'const { execa } = require("execa");\nexports.describe = () => execa("git", ["describe"]);\n';
    const runModule =
      'const { execa } = require("execa");\nexports.run = () => execa("git", ["status"]);\n';
    const { result, report } = compare(
      {
        "index.js": `${describeModule}exports.run = require("./lib/run").run;\n`,
        "lib/run.js": runModule,
      },
      {
        "index.js": `${describeModule}exports.run = require("./src/run").run;\n`,
        "src/run.js": runModule,
        "tools.js":
          'const { execaCommand } = require("execa");\nexports.run = (cmd) => execaCommand(cmd, { shell: true });\n',
      },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal(report.verdict.decision, "block");
    const [finding] = report.findings.filter((item) => item.rule === "RW-C06");
    // High as for a new child_process call; the moved, byte-identical
    // src/run.js did not change.
    assert.equal(finding.severity, "high");
    assert.deepEqual(
      finding.evidence.map((item) => [item.claim, item.basis]),
      [
        [
          "index.js imports execa, as it did in v1.0.0, and changed",
          "inferred",
        ],
        ["tools.js imports execa", "inferred"],
        [
          "Release Watch lists packages that start processes; REA's child-process extraction models node:child_process calls only",
          "heuristic",
        ],
      ],
    );
  });
});

describe(
  "compare: code that binds or runs no child_process value",
  { skip },
  () => {
    it("names the process call, not a method called on its result", () => {
      const { result, report } = compare(OLD, {
        ...OLD,
        "pods.mjs":
          'import { execSync } from "child_process";\nexport const pods = (cmd) => execSync(cmd, { encoding: "utf8" }).trim().split(" ");\nexport const raw = (cmd) => execSync(cmd).toString().trim();\n',
        // A minified bundle's renamed import.
        "cli.mjs":
          'import { exec as Vi, execSync as mo } from "child_process";\nexport const has = (cmd, name) => mo(cmd, { encoding: "utf8" }).includes(name);\n',
      });
      assert.equal(result.status, 2, result.stderr);
      for (const line of [2, 3])
        assertGap(
          report,
          ["pods.mjs", line],
          /^REA classified no process call where pods\.mjs calls execSync \(execSync is imported from child_process\)$/,
        );
      assertGap(
        report,
        ["cli.mjs", 2],
        /^REA classified no process call where cli\.mjs calls mo \(mo is child_process's execSync, imported under another name\)$/,
      );
      const claims = JSON.stringify(report.findings);
      for (const member of ["trim", "toString", "includes", "split"])
        assert.ok(!claims.includes(`.${member} (`), member);
    });

    it("reports no gap for a side-effect import, and keeps the real ones visible", () => {
      const chunk = (word) =>
        `import"node:path";import"child_process";\nexport const greet = (name) => "${word} " + name;\n`;
      const chunks = (word) =>
        Object.fromEntries(
          ["a", "b", "c", "d", "e", "f", "g"].map((name) => [
            `dist/${name}.service.mjs`,
            chunk(word),
          ]),
        );
      const holder = {
        "dist/cp.cjs": 'module.exports = require("child_process");\n',
      };
      const { result, report } = compare(
        { ...OLD, ...holder, ...chunks("hello") },
        {
          ...OLD,
          ...holder,
          ...chunks("hi"),
          // A side-effect import of a local module that holds child_process.
          "dist/load.mjs":
            'import "./cp.cjs";\nexport const ready = () => true;\n',
          "dist/cli.mjs":
            'import { execSync as Q } from "child_process";\nexport const token = () => Q("gh auth token", { encoding: "utf8" });\n',
        },
      );
      assert.equal(result.status, 2, result.stderr);
      const [coverage] = report.findings.filter(
        (finding) => finding.rule === "RW-C01",
      );
      assert.match(
        coverage.summary,
        /^REA could not fully examine dist\/cli\.mjs, which changed/,
      );
      assertGap(
        report,
        ["dist/cli.mjs", 2],
        /^REA classified no process call where dist\/cli\.mjs calls Q /,
      );
      assert.ok(
        !JSON.stringify(report.findings).includes("ties no binding"),
        JSON.stringify(coverage.evidence),
      );
    });

    it("passes declaration files that import child_process, an HTTP client module or a process library", () => {
      const before = {
        ...OLD,
        "client.js":
          'import axios from "axios";\nexport const getThing = () => axios.get("/thing");\n',
        "run.js":
          'const { execa } = require("execa");\nexports.run = () => execa("git", ["status"]);\n',
      };
      const { result, report } = compare(before, {
        ...before,
        "types.d.ts":
          'import { ChildProcess, SpawnOptions } from "child_process";\nexport interface Proc {\n  process: ChildProcess;\n}\nexport declare function start(options: SpawnOptions): ChildProcess;\n',
        "index.d.ts":
          'export { getThing } from "./client.js";\nexport type { Proc } from "./types";\n',
        "shell.d.cts":
          'import { ExecaChildProcess } from "execa";\nexport declare const child: ExecaChildProcess;\n',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(report.findings, []);
    });
  },
);

describe("compare: loads REA shows no use of", { skip }, () => {
  it("lists a require REA shows no use of after the gaps at a use it shows", () => {
    // Rollup's CommonJS output for `import "child_process"`: REA reports
    // no statement facts, so its discarded result reads like one that
    // goes where REA's graph does not show, and stays a possible gap.
    const chunk = (word) =>
      `'use strict';\nrequire('node:path');\nrequire('child_process');\nrequire('node:child_process');\nexports.greet = (name) => "${word} " + name;\n`;
    const chunks = (word) =>
      Object.fromEntries(
        ["a", "b", "c", "d", "e", "f", "g"].map((name) => [
          `dist/${name}.service.cjs`,
          chunk(word),
        ]),
      );
    const { result, report } = compare(
      { ...OLD, ...chunks("hello") },
      {
        ...OLD,
        ...chunks("hi"),
        "dist/cli.cjs":
          "'use strict';\nconst { execSync: Q } = require('child_process');\nexports.token = () => Q('gh auth token', { encoding: 'utf8' }).trim();\n",
      },
    );
    assert.equal(result.status, 2, result.stderr);
    const [coverage] = report.findings.filter(
      (finding) => finding.rule === "RW-C01",
    );
    assert.match(
      coverage.summary,
      /^REA could not fully examine dist\/cli\.cjs, dist\/[a-g]\.service\.cjs,/,
    );
    assert.match(
      coverage.evidence[0].claim,
      /^REA classified no process call where dist\/cli\.cjs calls Q /,
    );
    assert.ok(
      coverage.evidence
        .slice(1)
        .some((item) =>
          /^REA ties no binding to the result of require\("(node:)?child_process"\) in dist\/[a-g]\.service\.cjs/.test(
            item.claim,
          ),
        ),
      JSON.stringify(coverage.evidence),
    );
  });
});
