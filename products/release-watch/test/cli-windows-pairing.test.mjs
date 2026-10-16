// Runs the public CLI on small Electron releases each test writes, for
// window pairing that depends on REA's real output: the binding or member
// that holds a window, the functions that create it, the calls that load
// into it, and windows that move between components.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const electron = 'const { app, BrowserWindow } = require("electron");\n';
const options = (sandbox) =>
  `{ webPreferences: { contextIsolation: true, sandbox: ${sandbox} } }`;
const APP_URL = 'loadURL("https://app.acme.example/")';

const compare = (before, after, pkg = { main: "main.js" }) => {
  const result = run(
    written.write("1.0.0", before, pkg),
    written.write("1.1.0", after, pkg),
    "--vendor-domain",
    "acme.example",
  );
  written.keep(result.out);
  return result;
};
// Each RW-E02 finding as severity, title and component.
const windowFindings = ({ result, report }) => {
  assert.ok(report, result.stderr);
  return report.findings
    .filter((finding) => finding.rule === "RW-E02")
    .map((finding) => [finding.severity, finding.title, finding.component]);
};
const SANDBOX_OFF = "Renderer sandbox turned off (sandbox: false)";

describe("compare: which window is which across releases", { skip }, () => {
  // The window that loads the remote app loses its sandbox and the About
  // window gains it, so pairing by options alone hides the change.
  it("tells same-named locals of different functions apart", () => {
    const source = (main, about) =>
      `${electron}function createMainWindow() {\n  const win = new BrowserWindow(${options(main)});\n  win.${APP_URL};\n  return win;\n}\nfunction createAboutWindow() {\n  const win = new BrowserWindow(${options(about)});\n  win.loadFile("about.html");\n  return win;\n}\napp.whenReady().then(() => { createMainWindow(); createAboutWindow(); });\n`;
    assert.deepEqual(
      windowFindings(
        compare(
          { "main.js": source(true, false) },
          { "main.js": source(false, true) },
        ),
      ),
      [["high", SANDBOX_OFF, "app"]],
    );
  });

  it("pairs windows held in this and in object members", () => {
    const source = (main, about) =>
      `${electron}class MainWindow {\n  open() {\n    this.win = new BrowserWindow(${options(main)});\n    this.win.${APP_URL};\n  }\n}\nclass AboutWindow {\n  open() {\n    this.win = new BrowserWindow(${options(about)});\n    this.win.loadFile("about.html");\n  }\n}\nconst windows = {};\napp.whenReady().then(() => {\n  new MainWindow().open();\n  new AboutWindow().open();\n  windows.chat = new BrowserWindow(${options(main)});\n  windows.chat.loadURL("https://chat.acme.example/");\n  windows.prefs = new BrowserWindow(${options(about)});\n  windows.prefs.loadFile("prefs.html");\n});\n`;
    const { result, report } = compare(
      { "main.js": source(true, false) },
      { "main.js": source(false, true) },
    );
    assert.deepEqual(windowFindings({ result, report }), [
      ["high", SANDBOX_OFF, "app"],
    ]);
    assert.deepEqual(
      report.findings[0].evidence
        .filter((item) => item.side === "right" && item.location)
        .map((item) => item.location.line)
        .sort((a, b) => a - b),
      [4, 18],
      "the windows that load the app and the chat",
    );
  });

  // `let win` is assigned in two create functions and loaded in two show
  // functions, so which window a call loads into is not established.
  const shared = (first, second) =>
    `${electron}let win;\n${first}\n${second}\nfunction showMain() { createMain(); win.${APP_URL}; }\nfunction showLegacy() { createLegacy(); win.loadFile("legacy.html"); }\napp.whenReady().then(() => (process.argv.includes("--legacy") ? showLegacy() : showMain()));\n`;
  const creator = (name, sandbox) =>
    `function ${name}() { win = new BrowserWindow(${options(sandbox)}); }`;

  it("does not report create functions that were only reordered", () => {
    assert.deepEqual(
      windowFindings(
        compare(
          {
            "main.js": shared(
              creator("createMain", true),
              creator("createLegacy", false),
            ),
          },
          {
            "main.js": shared(
              creator("createLegacy", false),
              creator("createMain", true),
            ),
          },
        ),
      ),
      [],
    );
  });

  it("grades the create function whose window lost its sandbox after a reorder", () => {
    assert.deepEqual(
      windowFindings(
        compare(
          {
            "main.js": shared(
              creator("createMain", true),
              creator("createLegacy", false),
            ),
          },
          {
            "main.js": shared(
              creator("createLegacy", true),
              creator("createMain", false),
            ),
          },
        ),
      ),
      [["high", SANDBOX_OFF, "app"]],
    );
  });
});

describe("compare: minified windows", { skip }, () => {
  // A minifier renames the create functions from build to build (`n` and
  // `r` trade places) while what each window loads stays.
  it("pairs minified windows by what they load, not by renamed functions", () => {
    const create = (name, sandbox, load) =>
      `function ${name}(){const e=new o.BrowserWindow({webPreferences:{contextIsolation:true,sandbox:${sandbox}}});return e.${load},e}`;
    const bundle = (app, about) => ({
      "main.js": `"use strict";const o=require("electron");${app}${about}o.app.whenReady().then(()=>{n(),r()});\n`,
    });
    const old = bundle(
      create("n", true, APP_URL),
      create("r", false, 'loadFile("about.html")'),
    );
    const renamed = (app, about) =>
      bundle(
        create("r", app, APP_URL),
        create("n", about, 'loadFile("about.html")'),
      );
    assert.deepEqual(
      windowFindings(compare(old, renamed(true, false))),
      [],
      "only the names changed",
    );
    assert.deepEqual(
      windowFindings(compare(old, renamed(false, true))),
      [["high", SANDBOX_OFF, "app"]],
      "the window that loads the app lost its sandbox",
    );
  });
});

// A release of named components, each with a main.js running `body`.
const manifest = (version, names) =>
  JSON.stringify({
    product: "Acme Desk",
    version,
    components: names.map((name) => ({ name, path: name })),
  });
const component = (name, version, body) => ({
  [`${name}/package.json`]: JSON.stringify({
    name: `acme-${name}`,
    version,
    main: "main.js",
  }),
  [`${name}/main.js`]: `${electron}app.whenReady().then(() => {\n${body}});\n`,
});
const held = (name, sandbox, load) =>
  `  const ${name} = new BrowserWindow(${options(sandbox)});\n  ${name}.${load};\n`;

describe("compare: windows across components", { skip }, () => {
  // core's only window moves to viewer unchanged; browser is a new
  // component with a new unsandboxed window that one old window cannot
  // also explain.
  it("lets one old window explain at most one new window", () => {
    const legacy = held("legacyWin", false, 'loadFile("legacy.html")');
    const findings = windowFindings(
      compare(
        {
          "release-watch.json": manifest("1.0.0", ["core"]),
          ...component("core", "1.0.0", legacy),
        },
        {
          "release-watch.json": manifest("1.1.0", [
            "core",
            "viewer",
            "browser",
          ]),
          ...component("core", "1.1.0", ""),
          ...component("viewer", "1.1.0", legacy),
          ...component(
            "browser",
            "1.1.0",
            held(
              "browserWin",
              false,
              'loadURL("https://marketplace.acme.example/")',
            ),
          ),
        },
      ),
    );
    assert.deepEqual(findings, [
      [
        "high",
        "New BrowserWindow without the renderer sandbox (sandbox: false)",
        "browser",
      ],
    ]);
  });

  // Both components exist in both releases. app's windows move to shell:
  // the legacy window unchanged, the main window losing its sandbox, while
  // shell's own debug window with the same options is removed.
  it("pairs windows that moved between existing components", () => {
    const { result, report } = compare(
      {
        "release-watch.json": manifest("1.0.0", ["app", "shell"]),
        ...component(
          "app",
          "1.0.0",
          `${held("mainWin", true, APP_URL)}${held("legacyWin", false, 'loadFile("legacy.html")')}`,
        ),
        ...component(
          "shell",
          "1.0.0",
          held("debugWin", false, 'loadFile("debug.html")'),
        ),
      },
      {
        "release-watch.json": manifest("1.1.0", ["app", "shell"]),
        ...component("app", "1.1.0", ""),
        ...component(
          "shell",
          "1.1.0",
          `${held("mainWin", false, APP_URL)}${held("legacyWin", false, 'loadFile("legacy.html")')}`,
        ),
      },
    );
    assert.deepEqual(windowFindings({ result, report }), [
      ["high", SANDBOX_OFF, "shell"],
    ]);
    const claims = report.findings[0].evidence.map((item) => item.claim);
    assert.ok(
      claims.includes(
        "v1.0.0: BrowserWindow in main.js of component app: sandbox = true",
      ),
      JSON.stringify(claims),
    );
  });
});

describe("compare: a window new in an existing component", { skip }, () => {
  // app removes its debug window and shell, in both releases, gains an
  // unrelated one with the same options: nothing but options relates them.
  it("does not hide a new window behind one another existing component removed", () => {
    const findings = windowFindings(
      compare(
        {
          "release-watch.json": manifest("1.0.0", ["app", "shell"]),
          ...component(
            "app",
            "1.0.0",
            `${held("mainWin", true, APP_URL)}${held("debugWin", false, 'loadFile("debug.html")')}`,
          ),
          ...component("shell", "1.0.0", ""),
        },
        {
          "release-watch.json": manifest("1.1.0", ["app", "shell"]),
          ...component("app", "1.1.0", held("mainWin", true, APP_URL)),
          ...component(
            "shell",
            "1.1.0",
            held(
              "marketWin",
              false,
              'loadURL("https://marketplace.acme.example/")',
            ),
          ),
        },
      ),
    );
    assert.deepEqual(findings, [
      [
        "high",
        "New BrowserWindow without the renderer sandbox (sandbox: false)",
        "shell",
      ],
    ]);
  });
});
