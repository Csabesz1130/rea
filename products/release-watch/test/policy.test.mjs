import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffApplications, diffFuses, diffKeyed } from "../src/diff.mjs";
import { evaluatePolicy, verdictFor } from "../src/policy.mjs";

const at = (file, line, column = 0) => ({ file, line, column });
const fact = (key, data, location = null, state = "observed") => ({
  key,
  label: key,
  node_id: `${key}@${location?.file}:${location?.line}`,
  location,
  state,
  authority: "test",
  confidence: "exact",
  artifact_sha256: null,
  data,
});

const app = (overrides = {}) => ({
  coverage: { graph: "complete", semantic: "partial" },
  summary: { sender_validation_observations: 0 },
  modules: new Map(),
  assets: [],
  ipcHandlers: [],
  bridgeMembers: [],
  windows: [],
  requests: [],
  childProcesses: [],
  timers: [],
  urlLiterals: [],
  bindingReads: [],
  ...overrides,
});

const range = (line, startColumn, endColumn) => ({
  start: { line, column: startColumn },
  end: { line, column: endColumn },
});

const release = (label, application, extra = {}) => ({
  label,
  app: application,
  runtime: null,
  helpers: [],
  ...extra,
});

const evaluate = (left, right, options = {}) =>
  evaluatePolicy({
    left,
    right,
    labels: { left: left.label, right: right.label },
    options: { vendorDomains: [], failOn: "high", ...options },
    diff: {
      app: diffApplications(left.app, right.app),
      fuses: diffFuses(
        left.runtime?.fuses ?? null,
        right.runtime?.fuses ?? null,
      ),
      helpers: [],
    },
  });

// main.js exposes two new channels; only "diagnostics:run" reads the binding
// imported from the module that spawns processes.
const exposedApp = () =>
  app({
    modules: new Map([
      [
        "main.js",
        {
          builtins: new Set(),
          local: new Set(["lib/diagnostics.js", "lib/sync.js"]),
          imported: new Map([
            ["runDiagnostics", "lib/diagnostics.js"],
            ["syncNotes", "lib/sync.js"],
          ]),
        },
      ],
    ]),
    ipcHandlers: [
      fact(
        "diagnostics:run",
        { channel: "diagnostics:run", handler_range: range(21, 34, 78) },
        at("main.js", 21),
      ),
      fact(
        "notes:sync",
        { channel: "notes:sync", handler_range: range(19, 29, 80) },
        at("main.js", 19),
      ),
    ],
    bridgeMembers: [
      fact(
        "notes.runDiagnostics",
        { member: "notes.runDiagnostics", channel: "diagnostics:run" },
        at("preload.js", 3),
        "inferred",
      ),
      fact(
        "notes.sync",
        { member: "notes.sync", channel: "notes:sync" },
        at("preload.js", 3),
        "inferred",
      ),
    ],
    bindingReads: [
      fact(
        "main.js#runDiagnostics",
        { module: "main.js", name: "runDiagnostics", range: range(21, 55, 69) },
        at("main.js", 21),
      ),
      fact(
        "main.js#syncNotes",
        { module: "main.js", name: "syncNotes", range: range(19, 35, 44) },
        at("main.js", 19),
      ),
    ],
    childProcesses: [
      fact(
        "lib/diagnostics.js#exec",
        { module: "lib/diagnostics.js", method: "exec", command: null },
        at("lib/diagnostics.js", 5),
      ),
    ],
  });

describe("diffKeyed", () => {
  it("reports one-sided facts as added only when the other side's coverage is complete", () => {
    const right = [fact("a", {})];
    assert.equal(
      diffKeyed([], right, { leftComplete: true, rightComplete: true })[0]
        .status,
      "added",
    );
    assert.equal(
      diffKeyed([], right, { leftComplete: false, rightComplete: true })[0]
        .status,
      "not-previously-observed",
    );
    assert.equal(
      diffKeyed(right, [], { leftComplete: true, rightComplete: false })[0]
        .status,
      "no-longer-observed",
    );
  });

  it("keeps duplicate keys ambiguous instead of pairing by order", () => {
    const items = diffKeyed(
      [fact("w", { x: 1 })],
      [fact("w", { x: 1 }), fact("w", { x: 2 })],
      {
        leftComplete: true,
        rightComplete: true,
        unique: true,
      },
    );
    assert.equal(items[0].status, "ambiguous");
  });
});

describe("renderer process execution", () => {
  it("flags only the channel whose handler reads the binding imported from the exec module", () => {
    const findings = evaluate(
      release("v1", app()),
      release("v2", exposedApp()),
    );
    const critical = findings.filter((finding) => finding.rule === "RW-E01");
    assert.equal(critical.length, 1);
    assert.match(critical[0].title, /diagnostics:run/);
    assert.ok(
      critical[0].unknowns.length > 0,
      "the unproven argument flow stays explicit",
    );
    const sync = findings.find((finding) => finding.rule === "RW-E04");
    assert.equal(sync.severity, "low");
    assert.match(sync.title, /notes\.sync/);
    assert.equal(
      findings.filter((finding) => finding.rule === "RW-P01").length,
      0,
    );
  });

  it("falls back to a process-execution finding when no handler reaches the exec site", () => {
    const right = exposedApp();
    right.bindingReads = [];
    const findings = evaluate(release("v1", app()), release("v2", right));
    assert.equal(
      findings.filter((finding) => finding.rule === "RW-E01").length,
      0,
    );
    assert.equal(
      findings.filter((finding) => finding.rule === "RW-P01").length,
      1,
    );
  });
});

describe("network destinations", () => {
  const withRequest = (url) =>
    app({
      requests: [
        fact(
          "lib/x.js#fetch",
          { module: "lib/x.js", method: "fetch", endpoint: null },
          at("lib/x.js", 4),
        ),
      ],
      urlLiterals: url
        ? [
            fact(
              `lib/x.js#${url}`,
              { module: "lib/x.js", url, binding: "ENDPOINT" },
              at("lib/x.js", 1),
            ),
          ]
        : [],
    });

  it("grades by destination owner", () => {
    const options = { vendorDomains: ["acmenotes.example"] };
    const thirdParty = evaluate(
      release("v1", app()),
      release("v2", withRequest("https://ingest.other.example.net/e")),
      options,
    );
    const firstParty = evaluate(
      release("v1", app()),
      release("v2", withRequest("https://api.acmenotes.example/v2")),
      options,
    );
    const unresolved = evaluate(
      release("v1", app()),
      release("v2", withRequest(null)),
      options,
    );
    assert.equal(thirdParty[0].severity, "high");
    assert.equal(firstParty[0].severity, "low");
    assert.equal(unresolved[0].rule, "RW-N02");
    assert.equal(unresolved[0].severity, "medium");
  });

  it("states that REA did not resolve the request URL", () => {
    const [finding] = evaluate(
      release("v1", app()),
      release("v2", withRequest("https://x.example.org/")),
    );
    assert.ok(
      finding.unknowns.some((unknown) => /did not resolve/.test(unknown)),
    );
  });
});

describe("fuse regressions", () => {
  const runtime = (fuses, asarOutcome) => ({
    name: "app",
    fuses: {
      fuses,
      implications: [{ fuse_index: 4, outcome: asarOutcome }],
      limitations: [],
    },
  });

  it("downgrades ASAR integrity when REA cannot establish enforcement on the platform", () => {
    const left = release("v1", app(), {
      runtime: runtime(
        {
          RunAsNode: "disabled",
          EnableEmbeddedAsarIntegrityValidation: "enabled",
        },
        "enforced",
      ),
    });
    const right = release("v2", app(), {
      runtime: runtime(
        {
          RunAsNode: "enabled",
          EnableEmbeddedAsarIntegrityValidation: "disabled",
        },
        "unknown",
      ),
    });
    const [finding] = evaluate(left, right);
    assert.equal(finding.rule, "RW-E03");
    assert.equal(finding.severity, "high");
    assert.ok(
      finding.evidence.some((item) =>
        /AsarIntegrity.*\(low\)/.test(item.claim),
      ),
    );
  });

  it("ignores fuses that moved to their safe state", () => {
    const left = release("v1", app(), {
      runtime: runtime({ RunAsNode: "enabled" }, "unknown"),
    });
    const right = release("v2", app(), {
      runtime: runtime({ RunAsNode: "disabled" }, "unknown"),
    });
    assert.deepEqual(evaluate(left, right), []);
  });
});

describe("verdictFor", () => {
  it("blocks at the threshold and reviews medium findings", () => {
    assert.equal(verdictFor([{ severity: "high" }], "high").decision, "block");
    assert.equal(
      verdictFor([{ severity: "high" }], "critical").decision,
      "review",
    );
    assert.equal(
      verdictFor([{ severity: "medium" }], "high").decision,
      "review",
    );
    assert.equal(verdictFor([{ severity: "low" }], "high").decision, "pass");
    assert.equal(
      verdictFor([{ severity: "critical" }], "never").decision,
      "review",
    );
  });
});
