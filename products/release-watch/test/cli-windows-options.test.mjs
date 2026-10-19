// Runs the public CLI on small Electron releases each test writes, for
// webPreferences as REA reports them: values and objects it did not
// resolve, spreads, and a window new in the release.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const electron = 'const { app, BrowserWindow } = require("electron");\n';
const ready = (body) => `${electron}app.whenReady().then(() => {\n${body}});\n`;

const compare = (before, after) => {
  const result = run(
    written.write("1.0.0", { "main.js": before }, { main: "main.js" }),
    written.write("1.1.0", { "main.js": after }, { main: "main.js" }),
    "--vendor-domain",
    "acme.example",
  );
  written.keep(result.out);
  assert.ok(result.report, result.result.stderr);
  return result.report.findings.filter((finding) => finding.rule === "RW-E02");
};

describe("compare: webPreferences REA did not resolve", { skip }, () => {
  it("grades webPreferences and options REA reports as dynamic at medium", () => {
    const findings = compare(
      ready(
        '  const mainWin = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });\n  mainWin.loadURL("https://app.acme.example/");\n  const chatWin = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });\n  chatWin.loadURL("https://chat.acme.example/");\n',
      ),
      `const PREFS = { contextIsolation: false, sandbox: false };\nconst opts = { webPreferences: PREFS };\n${ready(
        '  const mainWin = new BrowserWindow({ width: 800, webPreferences: PREFS });\n  mainWin.loadURL("https://app.acme.example/");\n  const chatWin = new BrowserWindow(opts);\n  chatWin.loadURL("https://chat.acme.example/");\n',
      )}`,
    );
    assert.deepEqual(
      findings.map((finding) => [
        finding.severity,
        finding.title,
        finding.summary,
      ]),
      [
        [
          "medium",
          "webPreferences no longer statically known",
          "2 BrowserWindows in main.js took sandbox, contextIsolation, nodeIntegration, nodeIntegrationInWorker, webSecurity, allowRunningInsecureContent from values REA did not resolve in v1.1.0, where the v1.0.0 windows Release Watch paired with them did not.",
        ],
      ],
    );
  });

  // The old spread sets sandbox, so the new false value is not claimed to
  // turn off a safeguard the old window had.
  it("does not take an option a spread may set for Electron's default", () => {
    const [finding, ...rest] = compare(
      `const shared = require("./window-defaults.json");\n${ready(
        '  const mainWin = new BrowserWindow({ webPreferences: { ...shared.webPreferences, contextIsolation: true } });\n  mainWin.loadFile("index.html");\n',
      )}`,
      ready(
        '  const mainWin = new BrowserWindow({ webPreferences: { sandbox: false, contextIsolation: true } });\n  mainWin.loadFile("index.html");\n',
      ),
    );
    assert.deepEqual(rest, []);
    assert.deepEqual(
      [finding.severity, finding.title, finding.summary],
      [
        "medium",
        "Renderer sandbox off, old value not established (sandbox: false)",
        "1 BrowserWindow in main.js set sandbox to the unsafe value in v1.1.0, where the v1.0.0 window Release Watch paired with it took it from a value REA did not resolve.",
      ],
    );
    assert.ok(
      finding.evidence.some(
        (item) =>
          item.claim ===
          "v1.0.0: BrowserWindow in main.js: sandbox may be set by ...shared.webPreferences, which REA did not resolve",
      ),
      JSON.stringify(finding.evidence),
    );
    assert.ok(
      finding.evidence.every((item) => !/omits/.test(item.claim)),
      "the old window did not omit sandbox",
    );
    assert.ok(
      finding.unknowns.some((unknown) =>
        /old state is not established/.test(unknown),
      ),
    );
  });

  it("grades a dynamic value that changed at medium", () => {
    const window = (sandbox, nodeIntegration) =>
      ready(
        `  const mainWin = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: ${sandbox}, nodeIntegration: ${nodeIntegration} } });\n  mainWin.loadURL("https://app.acme.example/");\n`,
      );
    assert.deepEqual(
      compare(
        window("app.isPackaged", "!app.isPackaged"),
        window("!app.isPackaged", "app.isPackaged"),
      ).map((finding) => [finding.severity, finding.title]),
      [
        [
          "medium",
          "Renderer sandbox set to a different dynamic value (sandbox)",
        ],
        [
          "medium",
          "Node.js integration in the renderer set to a different dynamic value (nodeIntegration)",
        ],
      ],
    );
  });
});

describe("compare: a reformatted dynamic value", { skip }, () => {
  // Quoting, spacing and parentheses around a name or the whole expression
  // change nothing; the `!` dropped from nodeIntegration does.
  it("does not report a dynamic value that was only reformatted", () => {
    const window = (preferences) =>
      ready(
        `  const mainWin = new BrowserWindow({ webPreferences: { ${preferences} } });\n  mainWin.loadURL("https://app.acme.example/");\n`,
      );
    assert.deepEqual(
      compare(
        window(
          'contextIsolation: !process.env.NO_ISOLATION, sandbox: process.env.SB !== "0", nodeIntegration: !app.isPackaged',
        ),
        window(
          "contextIsolation: !(process.env.NO_ISOLATION), sandbox: (process.env.SB!=='0'), nodeIntegration: app.isPackaged",
        ),
      ).map((finding) => [finding.severity, finding.title]),
      [
        [
          "medium",
          "Node.js integration in the renderer set to a different dynamic value (nodeIntegration)",
        ],
      ],
    );
  });
});

describe("compare: a window new in the release", { skip }, () => {
  it("says the window is new and that Release Watch found no counterpart", () => {
    const main =
      '  const main = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true } });\n  main.loadFile("index.html");\n';
    const [finding] = compare(
      ready(main),
      ready(
        `${main}  const viewer = new BrowserWindow({ webPreferences: { sandbox: false, contextIsolation: true } });\n  viewer.loadURL("https://docs.acme.example/viewer");\n`,
      ),
    );
    assert.deepEqual(
      [finding.severity, finding.title, finding.summary],
      [
        "high",
        "New BrowserWindow without the renderer sandbox (sandbox: false)",
        "1 new BrowserWindow in main.js set sandbox to the unsafe value in v1.1.0; Release Watch paired no v1.0.0 window with it.",
      ],
    );
    const pairing = finding.evidence.find((item) =>
      /paired no v1\.0\.0 BrowserWindow/.test(item.claim),
    );
    assert.deepEqual(
      [pairing?.basis, pairing?.source],
      ["heuristic", "Release Watch"],
    );
  });
});
