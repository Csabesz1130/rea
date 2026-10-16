// Runs the public CLI on small releases each test writes, for URLs a
// request or an HTTP client reads through REA's property-slot and
// member-read facts: object properties, namespace members, and modules
// that only import a client wrapper.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { releases, run, skip } from "./cli-run.mjs";

const written = releases();
after(() => written.cleanup());

const PKG = { type: "module", main: "src/server.js" };

const compare = (before, after) => {
  const result = run(
    written.write("1.0.0", before, PKG),
    written.write("1.1.0", after, PKG),
  );
  written.keep(result.out);
  return result;
};

const graded = (report) =>
  report.findings.map((finding) => [
    finding.rule,
    finding.severity,
    finding.title,
  ]);

const claims = (finding) => finding.evidence.map((item) => item.claim);

const CLIENT =
  'import axios from "axios";\nimport { API } from "./config.js";\nexport const client = axios.create({ baseURL: API.baseURL });\nexport const sync = (data) => client.post("/ingest", data);\n';
const SERVER =
  'import { sync } from "./client.js";\nexport const handle = (req) => sync({ path: req.url });\n';

describe("compare: URLs read through objects and namespaces", { skip }, () => {
  it("attributes requests to an imported object's property and a namespace member", () => {
    const constants =
      'export const ENDPOINTS = {\n  notes: "https://db.acmenotes.example/notes",\n  telemetry: "https://collect.metrics-hub.example/v1",\n};\n';
    const shared = {
      "src/constants.js": constants,
      "src/errors.js":
        'export const ERRORS_URL = "https://errors.metrics-hub.example/v1";\n',
      "src/config/index.js": 'export * from "../errors.js";\n',
    };
    const head =
      'import { ENDPOINTS } from "./constants.js";\nimport * as C from "./config/index.js";\nexport const notes = () => fetch(ENDPOINTS.notes);\n';
    const { result, report } = compare(
      { ...shared, "src/server.js": head },
      {
        ...shared,
        "src/server.js": `${head}export const track = (e) => fetch(ENDPOINTS.telemetry, { method: "POST", body: e });\nexport const fail = (e) => fetch(C.ERRORS_URL, { method: "POST", body: e });\n`,
      },
    );
    assert.equal(result.status, 2, result.stderr);
    // Both bound requests are graded by their host; none is left unresolved.
    assert.deepEqual(graded(report).sort(), [
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
    ]);
    const all = report.findings.flatMap(claims);
    assert.ok(
      all.some((claim) => /assigned to ENDPOINTS\.telemetry/.test(claim)),
      all.join("\n"),
    );
    assert.ok(
      all.some((claim) =>
        /The request reads C\.ERRORS_URL inside its call/.test(claim),
      ),
      all.join("\n"),
    );
  });
});

describe("compare: URLs an HTTP client reads", { skip }, () => {
  it("takes only the property an axios client reads from an imported config object as a guess", () => {
    const config = (url) =>
      `export const API = { baseURL: "${url}", docs: "https://help.partner-docs.example/sync", timeout: 5000 };\n`;
    const { result, report } = compare(
      {
        "src/config.js": config("https://sync.acmenotes.example/v1"),
        "src/client.js": CLIENT,
        "src/server.js": SERVER,
      },
      {
        "src/config.js": config("https://ingest.datacollect.example/v1"),
        "src/client.js": CLIENT,
        "src/server.js": SERVER,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    // API.docs, which the client does not read, is not a destination.
    assert.deepEqual(graded(report), [
      [
        "RW-N01",
        "medium",
        "Possible new third-party destination: ingest.datacollect.example",
      ],
      [
        "RW-C05",
        "low",
        "Requests through axios in new or changed code are not examined",
      ],
    ]);
    assert.ok(
      claims(report.findings[0]).some((claim) =>
        /src\/client\.js imports axios, .*and imports the value src\/config\.js assigns to API\.baseURL/.test(
          claim,
        ),
      ),
      claims(report.findings[0]).join("\n"),
    );
  });

  it("does not take a link in a module that only imports the client wrapper as a destination", () => {
    const config =
      'export const API = { baseURL: "https://sync.acmenotes.example/v1" };\n';
    const { result, report } = compare(
      {
        "src/config.js": config,
        "src/client.js": CLIENT,
        "src/server.js": SERVER,
      },
      {
        "src/config.js": config,
        "src/client.js": CLIENT,
        "src/server.js": `const HELP_URL = "https://docs.helpcenter-partner.example/start";\n${SERVER}export const link = () => \`<\${HELP_URL}>; rel="help"\`;\n`,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(graded(report), [
      [
        "RW-C05",
        "low",
        "Requests through axios in new or changed code are not examined",
      ],
    ]);
  });

  it("does not say a URL in a default-exported config object is reported", () => {
    const client =
      'import axios from "axios";\nimport config from "./config.js";\nexport const client = axios.create(config);\nexport const sync = (data) => client.post("/ingest", data);\n';
    const config = (url) =>
      `export default { baseURL: "${url}", timeout: 5000 };\n`;
    const { result, report } = compare(
      {
        "src/config.js": config("https://sync.acmenotes.example/v1"),
        "src/client.js": client,
        "src/server.js": SERVER,
      },
      {
        "src/config.js": config("https://ingest.datacollect.example/v1"),
        "src/client.js": client,
        "src/server.js": SERVER,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    // REA reports no literal for this URL, so no rule can name its host.
    assert.deepEqual(graded(report), [
      [
        "RW-C05",
        "low",
        "Requests through axios in new or changed code are not examined",
      ],
    ]);
    assert.match(
      report.findings[0].why,
      /A URL REA reports no literal for \(one in an anonymous default-exported object, for example\)/,
    );
  });
});
