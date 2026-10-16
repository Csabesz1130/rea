// Runs the public CLI on small releases each test writes, for where a
// module's child_process value comes from when it imports no child_process
// itself: an unchanged local module that exports it, a load REA resolves to
// a constant, and require functions REA does not resolve.
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

// Asserts exactly the RW-C01 lines `[line, basis, claim]` in `file`.
const assertGaps = (report, file, expected) => {
  const lines = gapLines(report, file);
  assert.equal(lines.length, expected.length, JSON.stringify(lines));
  for (const [line, basis, claim] of expected)
    assert.ok(
      lines.some(
        (item) =>
          item.location.line === line &&
          item.basis === basis &&
          claim.test(item.claim),
      ),
      `${file}:${line} ${claim}: ${JSON.stringify(lines)}`,
    );
};

// Local modules that wrap child_process, shipped unchanged in both releases.
const LIBRARIES = {
  "lib/cp.js": 'module.exports = require("child_process");\n',
  "lib/spawn.js":
    'const { spawn } = require("child_process");\nmodule.exports = { spawn };\n',
  "lib/esm.mjs":
    'export { execSync } from "node:child_process";\nexport const name = "cp";\n',
  "lib/git.js":
    'const cp = require("child_process");\nexports.runGit = (args) => cp.execFileSync("git", args);\n',
};

describe("compare: child_process through a local module", { skip }, () => {
  it("follows what an unchanged module exports to the changed module that calls it", () => {
    const { result, report } = compare(
      { ...OLD, ...LIBRARIES },
      {
        ...OLD,
        ...LIBRARIES,
        "a.js":
          'const cp = require("./lib/cp");\nexports.f = (c) => cp.execSync(c);\n',
        "b.js":
          'const { spawn } = require("./lib/spawn");\nexports.f = (c) => spawn(c, [], { shell: true });\n',
        "c.mjs":
          'import { execSync } from "./lib/esm.mjs";\nexport const f = (c) => execSync(c);\n',
        // A helper whose own process call REA classified, and an export
        // that is not child_process.
        "d.js":
          'const { runGit } = require("./lib/git");\nexports.f = (args) => runGit(args);\n',
        "e.mjs":
          'import * as proc from "./lib/esm.mjs";\nexport const g = () => proc.name;\n',
      },
    );
    assert.equal(result.status, 2, result.stderr);
    // REA traces module.exports and the re-export to child_process.
    assertGaps(report, "a.js", [
      [
        2,
        "derived",
        /^REA classified no process call where a\.js calls cp\.execSync \(cp is child_process, which lib\/cp\.js exports\)$/,
      ],
    ]);
    assertGaps(report, "c.mjs", [
      [
        2,
        "derived",
        /^REA classified no process call where c\.mjs calls execSync \(execSync is child_process's execSync, which lib\/esm\.mjs exports\)$/,
      ],
    ]);
    // `module.exports = { spawn }`: REA traces no export named spawn.
    assertGaps(report, "b.js", [
      [
        2,
        "heuristic",
        /^REA classified no process call where b\.js calls spawn \(Release Watch takes spawn to hold child_process's spawn: lib\/spawn\.js holds it in spawn, whose use REA's graph does not show, and REA traced no export under that name\)$/,
      ],
    ]);
    for (const file of ["d.js", "e.mjs", ...Object.keys(LIBRARIES)])
      assertGaps(report, file, []);
  });
});

describe(
  "compare: child_process loaded without an import REA resolves",
  { skip },
  () => {
    it("follows a constant specifier and require functions to a child_process export", () => {
      const { result, report } = compare(OLD, {
        ...OLD,
        "named.js":
          'const name = "child_" + "process";\nexports.f = (c) => require(name).execSync(c);\n',
        "mod.js":
          'exports.f = (c) => module.require("child_process").execSync(c);\n',
        "main.js":
          'exports.f = (c) => process.mainModule.require("child_process").execSync(c);\n',
        // Names that are not child_process exports do not count.
        "plugins.js": 'exports.f = (n) => require(n).readFileSync("x");\n',
      });
      assert.equal(result.status, 2, result.stderr);
      assertGaps(report, "named.js", [
        [
          2,
          "derived",
          /^REA classified no process call where named\.js calls require\(name\)\.execSync \(require\(name\) loads child_process: REA reports name constant "child_process"\)$/,
        ],
      ]);
      for (const [file, loader] of [
        ["mod.js", /module\.require\(…\)/],
        ["main.js", /process\.mainModule\.require\(…\)/],
      ])
        assertGaps(report, file, [
          [
            1,
            "heuristic",
            new RegExp(
              `^REA classified no process call where ${file.replace(".", "\\.")} calls ${loader.source}\\.execSync \\(Release Watch takes ${loader.source} to load child_process: REA resolves no module for it, and the name read on it is a child_process export\\)$`,
            ),
          ],
        ]);
      assertGaps(report, "plugins.js", []);
    });

    it("follows createRequire's function, eval and a destructured window.require", () => {
      const { result, report } = compare(OLD, {
        ...OLD,
        "load.js":
          'const { createRequire } = require("node:module");\nconst load = createRequire(__filename);\nexports.f = (c) => load("child_process").execSync(c);\nexports.v = () => load("./package.json").version;\n',
        "evaled.js":
          'const cp = eval("require")("child_process");\nexports.f = (c) => cp.execSync(c);\n',
        "renderer.js":
          'const { exec } = window.require("child_process");\nconst { readFileSync } = window.require("fs");\nexports.f = (c) => exec(c);\nexports.g = (p) => readFileSync(p);\n',
      });
      assert.equal(result.status, 2, result.stderr);
      assertGaps(report, "load.js", [
        [
          3,
          "heuristic",
          /^REA classified no process call where load\.js calls load\(…\)\.execSync /,
        ],
      ]);
      assertGaps(report, "evaled.js", [
        [
          2,
          "heuristic",
          /^REA classified no process call where evaled\.js calls cp\.execSync \(cp is assigned eval\(…\)\(…\); Release Watch takes eval\(…\)\(…\) to load child_process: REA resolves no module for it\)$/,
        ],
      ]);
      assertGaps(report, "renderer.js", [
        [
          3,
          "heuristic",
          /^REA classified no process call where renderer\.js calls exec \(Release Watch takes exec to be child_process's exec: REA reports it destructured right before window\.require\(…\), whose result REA links to no binding; /,
        ],
      ]);
    });
  },
);
