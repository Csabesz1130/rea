// Runs the public CLI on multi-component releases each test writes, for
// code that moved between components: which removed site a moved request
// pairs with, what a moved module keeps, and what a new component's
// absence claims compare with.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

// Components named in the manifest; `files` holds every component's files.
const compare = ([oldVersion, newVersion], components, before, after) => {
  const manifest = (version, names) => ({
    "release-watch.json": JSON.stringify({
      product: "Notes",
      version,
      components: names.map((name) => ({ name, path: name })),
    }),
  });
  const result = run(
    written.write(oldVersion, {
      ...manifest(oldVersion, components.left),
      ...before,
    }),
    written.write(newVersion, {
      ...manifest(newVersion, components.right),
      ...after,
    }),
  );
  written.keep(result.out);
  return result;
};

const pkg = (name, main) =>
  JSON.stringify({ name, version: "1.0.0", type: "module", main });

const graded = (report) =>
  report.findings.map((finding) => [
    finding.rule,
    finding.severity,
    finding.component,
  ]);

const both = { left: ["api", "worker"], right: ["api", "worker"] };

describe(
  "compare: which removed request a moved one pairs with",
  { skip },
  () => {
    it("pairs a request whose file moved unchanged with its old copy and reports the new one", () => {
      const webhooks =
        'export const deliver = (hook, event) => fetch(hook.url, { method: "POST", body: JSON.stringify(event) });\n';
      const { result, report } = compare(
        ["1.0.0", "1.1.0"],
        both,
        {
          "api/package.json": pkg("notes-api", "src/server.js"),
          "api/src/server.js":
            'import { deliver } from "./webhooks.js";\nexport const handle = (req) => deliver({ url: req.headers["x-hook"] }, { path: req.url });\n',
          "api/src/webhooks.js": webhooks,
          "worker/package.json": pkg("notes-worker", "src/main.js"),
          "worker/src/main.js":
            'setInterval(() => console.log("tick"), 60000);\n',
        },
        {
          "api/package.json": pkg("notes-api", "src/server.js"),
          "api/src/server.js":
            'import { report } from "./diagnostics.js";\nexport const handle = () => report();\n',
          "api/src/diagnostics.js":
            'export const report = () => fetch(process.env.DIAG_ENDPOINT, { method: "POST", body: JSON.stringify({ env: process.env }) });\n',
          "worker/package.json": pkg("notes-worker", "src/main.js"),
          "worker/src/main.js":
            'import { deliver } from "./webhooks.js";\nsetInterval(() => deliver({ url: process.env.HOOK_URL }, { tick: Date.now() }), 60000);\n',
          "worker/src/webhooks.js": webhooks,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(graded(report), [["RW-N02", "medium", "api"]]);
      const [finding] = report.findings;
      assert.equal(
        finding.title,
        "New request with an unresolved destination in src/diagnostics.js",
      );
      assert.deepEqual(
        [...new Set(finding.evidence.map((item) => item.location?.file))],
        ["src/diagnostics.js"],
      );
    });
  },
);

describe(
  "compare: what code that moved between components keeps",
  { skip },
  () => {
    it("keeps the cleartext channel and eval of a module that moved unchanged, not of a URL constant that changed", () => {
      const legacy =
        'export const pushLegacy = () => fetch("http://legacy.partner-erp.example/sync", { method: "POST" });\nexport const evaluate = (expr) => eval(expr);\n';
      // An unchanged request that reads a constant whose URL lost https.
      const sync =
        'import { SYNC_URL } from "./config.js";\nexport const push = (notes) => fetch(SYNC_URL, { method: "POST", body: JSON.stringify(notes) });\n';
      const config = (scheme) =>
        `export const SYNC_URL = "${scheme}://sync.partner-erp.example/v1";\n`;
      const { result, report } = compare(
        ["1.0.0", "1.1.0"],
        both,
        {
          "api/package.json": pkg("notes-api", "src/server.js"),
          "api/src/server.js":
            'import { pushLegacy, evaluate } from "./legacy.js";\nimport { push } from "./sync.js";\nsetInterval(pushLegacy, 60000);\nexport { evaluate, push };\n',
          "api/src/legacy.js": legacy,
          "api/src/sync.js": sync,
          "api/src/config.js": config("https"),
          "worker/package.json": pkg("notes-worker", "src/main.js"),
          "worker/src/main.js":
            'setInterval(() => console.log("tick"), 60000);\n',
        },
        {
          "api/package.json": pkg("notes-api", "src/server.js"),
          "api/src/server.js":
            'import { push } from "./sync.js";\nexport { push };\n',
          "api/src/sync.js": sync,
          "api/src/config.js": config("http"),
          "worker/package.json": pkg("notes-worker", "src/main.js"),
          "worker/src/main.js":
            'import { pushLegacy, evaluate } from "./legacy.js";\nsetInterval(pushLegacy, 60000);\nexport { evaluate };\n',
          "worker/src/legacy.js": legacy,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(graded(report), [["RW-N03", "medium", "api"]]);
      const [finding] = report.findings;
      assert.equal(
        finding.title,
        "Cleartext connection to sync.partner-erp.example",
      );
      assert.match(
        finding.summary,
        /v1\.0\.0 reached it only over encrypted connections/,
      );
    });

    it("compares cleartext with the whole old release, and says another component had an eval", () => {
      const legacy = (extra) =>
        `export const pushLegacy = () => fetch("http://legacy.partner-erp.example/sync", { method: "POST" });\nexport const evaluate = (expr) => eval(expr);\n${extra}`;
      const { result, report } = compare(
        ["1.0.0", "1.1.0"],
        both,
        {
          "api/package.json": pkg("notes-api", "src/server.js"),
          "api/src/server.js":
            'import { pushLegacy, evaluate } from "./legacy.js";\nsetInterval(pushLegacy, 60000);\nexport { evaluate };\n',
          "api/src/legacy.js": legacy(""),
          "worker/package.json": pkg("notes-worker", "src/main.js"),
          "worker/src/main.js":
            'setInterval(() => console.log("tick"), 60000);\n',
        },
        {
          "api/package.json": pkg("notes-api", "src/server.js"),
          "api/src/server.js": "export const handle = () => 'ok';\n",
          "worker/package.json": pkg("notes-worker", "src/main.js"),
          "worker/src/main.js":
            'import { pushLegacy, evaluate } from "./legacy.js";\nsetInterval(pushLegacy, 60000);\nexport { evaluate };\n',
          // Moved and changed: what it does is compared, not paired.
          "worker/src/legacy.js": legacy("export const retries = 3;\n"),
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(graded(report), [["RW-W04", "low", "worker"]]);
      const [finding] = report.findings;
      assert.match(
        finding.summary,
        /\((absent from|not observed in) component worker of v1\.0\.0 \(old\); another component of v1\.0\.0 had one in a module at this path\)/,
      );
      assert.ok(
        finding.unknowns.some((unknown) =>
          /moved from or shared/.test(unknown),
        ),
        finding.unknowns.join("\n"),
      );
    });
  },
);

describe(
  "compare: what an unchanged HTTP client module keeps",
  { skip },
  () => {
    // RW-C05 notes new or changed code that uses an HTTP client REA does
    // not model; an unchanged copy of an old client module is neither.
    it("does not take an HTTP client module that moved unchanged, within or between components, for new client code", () => {
      const cjs = (name) =>
        JSON.stringify({ name, version: "1.0.0", main: "index.js" });
      const http =
        'const axios = require("axios");\nexports.get = (u) => axios.get(u);\n';
      const entry = (dir) =>
        `const { get } = require("./${dir}/http");\nexports.get = get;\n`;
      const { result, report } = compare(
        ["1.0.0", "1.1.0"],
        { left: ["api"], right: ["api", "net"] },
        {
          "api/package.json": cjs("notes-api"),
          "api/index.js": entry("lib"),
          "api/lib/http.js": http,
        },
        {
          "api/package.json": cjs("notes-api"),
          "api/index.js": entry("src"),
          "api/src/http.js": http,
          "net/package.json": cjs("notes-net"),
          "net/index.js": entry("lib"),
          "net/lib/http.js": http,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        graded(report).filter(([rule]) => rule !== "RW-C02"),
        [["RW-C05", "low", "api"]],
      );
      const finding = report.findings.find((item) => item.rule === "RW-C05");
      assert.deepEqual(
        finding.evidence.map((item) => item.claim),
        [
          "index.js changed and imports src/http.js, which imports axios",
          "Release Watch lists HTTP client packages whose calls REA's request extraction may not model",
        ],
      );
    });
  },
);

describe("compare: what a new component is compared with", { skip }, () => {
  it("does not say the old release lacked a service worker another component registered", () => {
    const page =
      '<!doctype html><html><head><script src="main.js"></script></head><body></body></html>\n';
    const worker =
      'self.addEventListener("fetch", (event) => event.respondWith(caches.match(event.request)));\n';
    const { result, report } = compare(
      ["4.0.0", "4.1.0"],
      { left: ["web"], right: ["web", "pwa"] },
      {
        "web/index.html": page,
        "web/main.js":
          'navigator.serviceWorker.register("/sw.js");\ndocument.title = "Notes";\n',
        "web/sw.js": worker,
      },
      {
        "web/index.html": page,
        "web/main.js": 'document.title = "Notes";\n',
        "pwa/index.html": page,
        "pwa/main.js": 'navigator.serviceWorker.register("/sw.js");\n',
        "pwa/sw.js": worker,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const finding = report.findings.find((item) => item.rule === "RW-W02");
    assert.equal(finding.component, "pwa");
    const [claim] = finding.evidence;
    assert.doesNotMatch(claim.claim, /not observed in v4\.0\.0|absent from/);
    assert.match(
      claim.claim,
      /component pwa is new; another component of v4\.0\.0 registered it/,
    );
    assert.ok(
      finding.unknowns.some((unknown) => /moved from or shared/.test(unknown)),
      finding.unknowns.join("\n"),
    );
  });

  it("does not say the old release lacked a service worker another component registered, for a component both have", () => {
    const page =
      '<!doctype html><html><head><script src="main.js"></script></head><body></body></html>\n';
    const worker =
      'self.addEventListener("fetch", (event) => event.respondWith(caches.match(event.request)));\n';
    const { result, report } = compare(
      ["4.0.0", "4.1.0"],
      { left: ["web", "pwa"], right: ["web", "pwa"] },
      {
        "web/index.html": page,
        "web/main.js":
          'navigator.serviceWorker.register("/sw.js");\ndocument.title = "Notes";\n',
        "web/sw.js": worker,
        "pwa/index.html": page,
        "pwa/main.js": 'document.title = "Notes app";\n',
      },
      {
        "web/index.html": page,
        "web/main.js": 'document.title = "Notes";\n',
        "pwa/index.html": page,
        "pwa/main.js":
          'navigator.serviceWorker.register("/sw.js");\ndocument.title = "Notes app";\n',
        "pwa/sw.js": worker,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const finding = report.findings.find((item) => item.rule === "RW-W02");
    assert.equal(finding.component, "pwa");
    const [claim] = finding.evidence;
    assert.doesNotMatch(claim.claim, /(absent from|not observed in) v4\.0\.0/);
    assert.match(
      claim.claim,
      /(absent from|not observed in) component pwa of v4\.0\.0; another component of v4\.0\.0 registered it/,
    );
  });
});
