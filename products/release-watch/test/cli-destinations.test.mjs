// Runs the public CLI on small releases each test writes, for destinations
// that depend on REA's real import, export and binding facts: URL constants
// behind barrels and HTTP clients, request sites added next to old ones,
// and browser code that starts calling a model provider.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const compare = (before, after, pkg = { type: "module" }) => {
  const result = run(
    written.write("1.0.0", before, pkg),
    written.write("1.1.0", after, pkg),
  );
  written.keep(result.out);
  return result;
};

const graded = (report) =>
  report.findings.map((finding) => [
    finding.rule,
    finding.severity,
    finding.component,
    finding.title,
  ]);

const claims = (finding) => finding.evidence.map((item) => item.claim);

// A two-component release: a web front end and its API.
const manifest = (version) =>
  JSON.stringify({
    product: "Chat",
    version,
    components: [
      { name: "web", path: "web" },
      { name: "api", path: "api" },
    ],
  });
const PAGE =
  '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body></body></html>\n';
const API_PACKAGE = JSON.stringify({
  name: "chat-api",
  version: "1.0.0",
  type: "module",
  main: "src/server.js",
});

describe("compare: destinations behind modules", { skip }, () => {
  it("takes the base URL an axios client imports from a config module as a guess", () => {
    const client =
      'import axios from "axios";\nimport { API_BASE } from "./config.js";\nexport const client = axios.create({ baseURL: API_BASE });\nexport const sync = (data) => client.post("/ingest", data);\n';
    const server =
      'import { sync } from "./client.js";\nexport const handle = (req) => sync({ path: req.url });\n';
    const config = (url) => `export const API_BASE = "${url}";\n`;
    const { result, report } = compare(
      {
        "src/config.js": config("https://sync.acmenotes.example/v1"),
        "src/client.js": client,
        "src/server.js": server,
      },
      {
        "src/config.js": config("https://ingest.datacollect.example/v1"),
        "src/client.js": client,
        "src/server.js": server,
      },
      { type: "module", main: "src/server.js" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(graded(report), [
      [
        "RW-N01",
        "medium",
        "app",
        "Possible new third-party destination: ingest.datacollect.example",
      ],
      [
        "RW-C05",
        "low",
        "app",
        "Requests through axios in new or changed code are not examined",
      ],
    ]);
    const [guess, coverage] = report.findings;
    assert.ok(
      claims(guess).some((claim) =>
        /src\/client\.js imports axios, .*and imports the value src\/config\.js assigns to API_BASE/.test(
          claim,
        ),
      ),
      claims(guess).join("\n"),
    );
    assert.ok(
      claims(coverage).some((claim) =>
        /src\/config\.js changed, and src\/client\.js, which imports axios, imports it/.test(
          claim,
        ),
      ),
      claims(coverage).join("\n"),
    );
    // The coverage finding no longer says such hosts go unreported.
    assert.match(coverage.why, /report as possible destinations/);
  });

  it("follows a URL constant through named and star re-exports", () => {
    const constants =
      'export const NOTES_URL = "https://db.acmenotes.example/notes";\nexport const TELEMETRY_URL = "https://collect.metrics-hub.example/v1";\n';
    const errors =
      'export const ERRORS_URL = "https://errors.metrics-hub.example/v1";\n';
    const barrels = {
      "src/constants.js": constants,
      "src/errors.js": errors,
      "src/config/index.js":
        'export { NOTES_URL, TELEMETRY_URL } from "../constants.js";\n',
      "src/more/index.js": 'export * from "../errors.js";\n',
    };
    const { result, report } = compare(
      {
        ...barrels,
        "src/server.js":
          'import { NOTES_URL } from "./config/index.js";\nexport const notes = () => fetch(NOTES_URL);\n',
      },
      {
        ...barrels,
        "src/server.js":
          'import { NOTES_URL, TELEMETRY_URL } from "./config/index.js";\nimport { ERRORS_URL } from "./more/index.js";\nexport const notes = () => fetch(NOTES_URL);\nexport const track = (e) => fetch(TELEMETRY_URL, { method: "POST", body: e });\nexport const fail = (e) => fetch(ERRORS_URL, { method: "POST", body: e });\n',
      },
      { type: "module", main: "src/server.js" },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(
      graded(report)
        .map(([rule, severity, , title]) => [rule, severity, title])
        .sort(),
      [
        [
          "RW-N01",
          "high",
          "New third-party destination: collect.metrics-hub.example",
        ],
        [
          "RW-N01",
          "high",
          "New third-party destination: errors.metrics-hub.example",
        ],
      ],
    );
  });
});

describe("compare: requests and hosts a release already had", { skip }, () => {
  it("does not report an old unresolved request when a module adds a resolved or explained one", () => {
    const { result, report } = compare(
      {
        "src/constants.js":
          'export const NOTES_URL = "https://db.acmenotes.example/notes";\nexport const TELEMETRY_URL = "https://collect.metrics-hub.example/v1";\n',
        "src/app.js":
          'import { NOTES_URL } from "./constants.js";\nexport const load = (id) => fetch(`/api/notes/${id}`);\nexport const notes = () => fetch(NOTES_URL);\n',
      },
      {
        "src/constants.js":
          'export const NOTES_URL = "https://db.acmenotes.example/notes";\nexport const TELEMETRY_URL = "https://collect.metrics-hub.example/v1";\n',
        "src/app.js":
          'import { NOTES_URL, TELEMETRY_URL } from "./constants.js";\nexport const load = (id) => fetch(`/api/notes/${id}`);\nexport const notes = () => fetch(NOTES_URL);\nexport const health = () => fetch("https://status.acmenotes.example/health");\nexport const track = (e) => fetch(TELEMETRY_URL, { method: "POST", body: e });\n',
      },
      { type: "module", main: "src/app.js" },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(
      graded(report).map(([rule, severity, , title]) => [
        rule,
        severity,
        title,
      ]),
      [
        [
          "RW-N01",
          "high",
          "New third-party destination: collect.metrics-hub.example",
        ],
        [
          "RW-N01",
          "low",
          "New first-party destination: status.acmenotes.example",
        ],
      ],
    );
  });

  it("does not call a host the old release held a URL for unseen", () => {
    const { result, report } = compare(
      {
        "sync.js":
          'const axios = require("axios");\nconst SYNC_URL = "https://sync.partnercloud.example/v1/push";\nexports.push = (notes) => axios.post(SYNC_URL, notes);\n',
      },
      {
        "sync.js":
          'const SYNC_URL = "https://sync.partnercloud.example/v1/push";\nexports.push = (notes) => fetch(SYNC_URL, { method: "POST", body: JSON.stringify(notes) });\n',
      },
      { main: "sync.js" },
    );
    assert.equal(result.status, 2, result.stderr);
    const [finding] = report.findings;
    assert.deepEqual(
      [finding.rule, finding.severity],
      ["RW-N01", "high"],
      JSON.stringify(graded(report)),
    );
    assert.doesNotMatch(finding.summary, /not seen in/);
    assert.match(
      finding.summary,
      /v1\.0\.0's analyzed code held a URL for sync\.partnercloud\.example only next to requests REA could not resolve or does not model/,
    );
    assert.doesNotMatch(finding.why, /never used/);
    assert.ok(
      finding.unknowns.some((unknown) =>
        /v1\.0\.0's code held a URL for sync\.partnercloud\.example .* so it may have contacted it/.test(
          unknown,
        ),
      ),
      finding.unknowns.join("\n"),
    );
  });
});

describe(
  "compare: browser code that starts calling a provider",
  { skip },
  () => {
    const server = (call) => ({
      "api/package.json": API_PACKAGE,
      "api/src/server.js": `import http from "node:http";\n${call}`,
    });
    const openaiServer = server(
      'import OpenAI from "openai";\nconst client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });\nhttp.createServer(async (req, res) => {\n  const r = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: req.url }] });\n  res.end(r.choices[0].message.content);\n}).listen(8080);\n',
    );

    it("grades browser code that starts using a provider SDK the server used as a browser placement", () => {
      const { result, report } = compare(
        {
          "release-watch.json": manifest("1.0.0"),
          ...openaiServer,
          "web/index.html": PAGE,
          "web/assets/app.js":
            'export const ask = (q) => fetch("/api/chat?q=" + encodeURIComponent(q));\n',
        },
        {
          "release-watch.json": manifest("1.1.0"),
          ...openaiServer,
          "web/index.html": PAGE,
          "web/assets/app.js":
            'import OpenAI from "openai";\nconst client = new OpenAI({ apiKey: localStorage.getItem("key"), dangerouslyAllowBrowser: true });\nexport const ask = (q) => client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: q }] });\n',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(graded(report), [
        [
          "RW-A01",
          "medium",
          "web",
          "Browser code may call OpenAI directly through openai",
        ],
      ]);
    });

    it("does not count a URL old browser code only held as an old browser call", () => {
      const settings =
        'const DEFAULT_BASE = "https://api.openai.com/v1";\nconst api = (path) => `${location.origin}/api${path}`;\ndocument.querySelector("#base").placeholder = DEFAULT_BASE;\ndocument.querySelector("#save").onclick = () => fetch(api("/settings"), { method: "POST" });\n';
      const proxy = server(
        'http.createServer(async (req, res) => {\n  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: req.url });\n  res.end(await r.text());\n}).listen(8080);\n',
      );
      const { result, report } = compare(
        {
          "release-watch.json": manifest("1.0.0"),
          ...proxy,
          "web/index.html": PAGE,
          "web/assets/app.js": settings,
        },
        {
          "release-watch.json": manifest("1.1.0"),
          ...proxy,
          "web/index.html": PAGE,
          "web/assets/app.js": `${settings}export const ask = (key, content) => fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: \`Bearer \${key}\` }, body: content });\n`,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      // The old settings request is not new, so no RW-N02 either.
      assert.deepEqual(graded(report), [
        [
          "RW-A01",
          "medium",
          "web",
          "Browser code calls OpenAI directly (api.openai.com)",
        ],
      ]);
    });
  },
);
