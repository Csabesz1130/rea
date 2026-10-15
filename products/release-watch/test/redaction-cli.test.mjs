// The public CLI on small releases that plant fake secrets in source lines,
// script sources and service workers, under a caller-selected path that
// holds a UUID: report.json, Markdown and HTML must mask every planted value
// and keep the paths as given. Skipped when REA has not been built.
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
const reaBuilt = existsSync(path.resolve(product, "../../dist/cli.js"));
const skip = reaBuilt ? false : "REA is not built (npm run build:cached)";
const TAG = /‹[0-9a-f]{6}›/g;

const write = (root, files) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
};

const compare = (root, left, right) => {
  const out = path.join(root, "out");
  const result = spawnSync(
    process.execPath,
    [
      path.join(product, "bin", "release-watch.mjs"),
      "compare",
      left,
      right,
      "--out",
      out,
      "--jobs",
      "1",
    ],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  const read = (name) =>
    existsSync(path.join(out, name))
      ? readFileSync(path.join(out, name), "utf8")
      : "";
  const json = read("report.json");
  return {
    result,
    report: json ? JSON.parse(json) : null,
    outputs: [json, read("report.md"), read("report.html")],
  };
};

const evidenceAt = (report, file, line) =>
  report.findings
    .flatMap((finding) => finding.evidence)
    .find(
      (item) => item.location?.file === file && item.location.line === line,
    );

const pkg = (version) =>
  JSON.stringify({
    name: "leak-app",
    version,
    type: "module",
    main: "src/index.js",
  });

const APP_FILES = {
  "package.json": pkg("1.1.0"),
  "src/index.js": [
    'import "./k1.js";',
    'import "./a1.js";',
    'import "./b1.js";',
    'import "./g1.js";',
    'import "./long.js";',
    'export const hello = () => "hi";',
  ].join("\n"),
  "src/k1.js": `const KA = "sk-ant-api03-FAKEsplitPlusFirstHalfAAAA" +\n  "FAKEplusSecondHalfTail"; export const va = () => fetch("https://va.third.example/v1/e", { headers: { "x-api-key": KA } });\n`,
  "src/a1.js": `const h = {}; h["x-api-key"] = "FAKEbr77"; export const a1 = () => fetch("https://a1.third.example/v1/e", { headers: { Authorization: "Basic " + btoa("admin:FAKEpw99") }, body: h });\n`,
  "src/b1.js": `export const b1 = () => fetch(["https://b1.third.example/v1/data", "?token=", "FAKEjn5x"].join(""));\n`,
  "src/g1.js": `export const g1 = () => fetch("https://g1.third.example/v1?a=1&amp;b=2");\n`,
  "src/long.js": `export const ping = () => fetch("https://pixel.third.example/p?${Array.from({ length: 130_000 }, () => "a=b").join("&")}");\n`,
};

describe("compare: planted secrets in a JavaScript app", { skip }, () => {
  let root;
  let run;
  before(() => {
    root = mkdtempSync(
      path.join(tmpdir(), "rw-0199bedf-b8a3-5a58-a554-d9b6b6acb229-"),
    );
    write(path.join(root, "old"), {
      "package.json": pkg("1.0.0"),
      "src/index.js": 'export const hello = () => "hi";\n',
    });
    write(path.join(root, "new"), APP_FILES);
    run = compare(root, path.join(root, "old"), path.join(root, "new"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("writes every report and masks every planted value", () => {
    assert.equal(run.result.status, 2, run.result.stderr);
    for (const output of run.outputs) {
      assert.ok(output.length > 0);
      assert.ok(
        !output.includes("FAKE"),
        output.match(/.{0,80}FAKE.{0,40}/)?.[0],
      );
    }
  });

  it("keeps the caller-selected input and Evidence paths as given", () => {
    const [component] = run.report.components;
    assert.equal(component.left.input, path.join(root, "old"));
    assert.equal(component.right.input, path.join(root, "new"));
    assert.equal(
      component.right.application.evidence_file,
      "evidence/app-right-application.json",
    );
  });

  it("masks the strings of a line that continues a reported key", () => {
    const item = evidenceAt(run.report, "src/k1.js", 2);
    assert.match(item.snippet.text, /^"‹[0-9a-f]{6}›"; export const va/);
    assert.ok(
      item.snippet.text.includes('fetch("https://va.third.example/v1/e"'),
    );
  });

  it("shows a script's `&amp;` as written, as its claim does, and bounds a long query", () => {
    const item = evidenceAt(run.report, "src/g1.js", 1);
    assert.ok(item.snippet.text.includes("&amp;b=‹"), item.snippet.text);
    assert.deepEqual(item.snippet.text.match(TAG), item.claim.match(TAG));
    const long = evidenceAt(run.report, "src/long.js", 1);
    assert.ok(long.claim.length < 1500, `${long.claim.length}`);
  });
});

const PAGE = (scripts) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>App</title>\n${scripts.join("\n")}\n</head><body></body></html>\n`;
const RLO = String.fromCharCode(0x202e);

describe("compare: planted secrets in a web build", { skip }, () => {
  let root;
  let run;
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "rw-web-"));
    const app = '<script type="module" src="/assets/app.js"></script>';
    write(path.join(root, "old"), {
      "index.html": PAGE([app]),
      "assets/app.js": "export const x = 1;\n",
    });
    write(path.join(root, "new"), {
      "index.html": PAGE([
        '<script async src="\\\\cdn.tracker.example/t.js"></script>',
        '<script src="//maps.x.example/maps/api/js?callback=init&amp;key=FAKEk3y&Tab;TabRef51"></script>',
        '<script src="https://static.tracker.example/js/a1b2c3d4e5f6a7b8c9d0e1f2.js"></script>',
        app,
      ]),
      "assets/app.js": `navigator.serviceWorker.register("sw.js#access_token=FAKEswFrag0002");\nnavigator.serviceWorker.register("sw${RLO}gpj.js");\nexport const x = 1;\n`,
    });
    run = compare(root, path.join(root, "old"), path.join(root, "new"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("reads a backslash source as protocol-relative and keeps a hash-only asset name", () => {
    const titles = run.report.findings.map((finding) => finding.title);
    for (const host of [
      "cdn.tracker.example",
      "maps.x.example",
      "static.tracker.example",
    ])
      assert.ok(
        titles.some((title) => title.includes(host)),
        `${host}: ${titles}`,
      );
    assert.ok(run.outputs[0].includes("/js/a1b2c3d4e5f6a7b8c9d0e1f2.js"));
  });

  it("joins a src query value across `&Tab;`, giving the snippet its claim's tags", () => {
    const item = run.report.findings
      .flatMap((finding) => finding.evidence)
      .find((evidence) => evidence.claim.includes("maps.x.example"));
    assert.deepEqual(item.snippet.text.match(TAG), item.claim.match(TAG));
  });

  it("masks service worker fragments and encodes bidirectional characters in report.json", () => {
    for (const output of run.outputs)
      assert.ok(
        !/FAKE|TabRef51/.test(output),
        output.match(/.{0,80}(FAKE|TabRef).{0,40}/)?.[0],
      );
    assert.ok(!run.outputs[0].includes(RLO));
    assert.ok(run.outputs[0].includes("sw\\\\u202Egpj.js"));
  });
});

describe("compare: errors that name caller-selected paths", { skip }, () => {
  it("keeps a path holding a UUID in error text", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "rw-0199bedf-b8a3-5a58-a554-d9b6b6acb229-"),
    );
    mkdirSync(path.join(root, "empty-old"));
    mkdirSync(path.join(root, "empty-new"));
    try {
      const run = compare(
        root,
        path.join(root, "empty-old"),
        path.join(root, "empty-new"),
      );
      assert.equal(run.result.status, 1);
      assert.ok(
        run.report.errors[0].message.startsWith(
          `Nothing to analyze at ${path.join(root, "empty-old")}:`,
        ),
        run.report.errors[0].message,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
