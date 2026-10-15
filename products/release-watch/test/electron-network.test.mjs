import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { app, at, evaluate, fact, range, rules, side } from "./helpers.mjs";

// main.js exposes two new channels; only "diagnostics:run" reads the binding
// imported from the module that spawns processes.
const exposed = () =>
  app({
    modules: new Map([
      [
        "main.js",
        {
          externalImports: new Set(),
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
        { channel: "diagnostics:run", handler_range: range(21, 34, 21, 78) },
        at("main.js", 21),
      ),
      fact(
        "notes:sync",
        { channel: "notes:sync", handler_range: range(19, 29, 19, 80) },
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
        {
          module: "main.js",
          name: "runDiagnostics",
          range: range(21, 55, 21, 69),
        },
        at("main.js", 21),
      ),
      fact(
        "main.js#syncNotes",
        {
          module: "main.js",
          name: "syncNotes",
          range: range(19, 35, 19, 44),
        },
        at("main.js", 19),
      ),
    ],
    childProcesses: [
      fact(
        "lib/diagnostics.js#exec",
        {
          module: "lib/diagnostics.js",
          method: "exec",
          command: null,
          range: range(5, 4, 7, 6),
        },
        at("lib/diagnostics.js", 5),
      ),
    ],
  });

describe("Electron renderer process execution", () => {
  it("flags only the channel whose handler reads the binding imported from the exec module", () => {
    const findings = evaluate(side("v1", app()), side("v2", exposed()));
    const critical = findings.filter((finding) => finding.rule === "RW-E01");
    assert.equal(critical.length, 1);
    assert.match(critical[0].title, /diagnostics:run/);
    assert.ok(
      critical[0].unknowns.length > 0,
      "the unproven argument flow stays explicit",
    );
    assert.match(
      findings.find((finding) => finding.rule === "RW-E04").title,
      /notes\.sync/,
    );
    assert.equal(
      findings.filter((finding) => finding.rule === "RW-P01").length,
      0,
    );
  });

  it("falls back to a process-execution finding when no handler reaches the exec site", () => {
    const right = exposed();
    right.bindingReads = [];
    const findings = evaluate(side("v1", app()), side("v2", right));
    assert.deepEqual(
      rules(findings).filter((rule) => rule === "RW-E01" || rule === "RW-P01"),
      ["RW-P01"],
    );
  });
});

describe("network destinations", () => {
  const withRequest = (module, url) =>
    app({
      requests: [
        fact(
          `${module}#fetch`,
          { module, method: "fetch", endpoint: null },
          at(module, 4),
        ),
      ],
      urlLiterals: url
        ? [
            fact(
              url,
              { module, url, value: url, binding: "ENDPOINT" },
              at(module, 1),
            ),
          ]
        : [],
    });

  it("grades by destination owner", () => {
    const options = { vendorDomains: ["acmenotes.example"] };
    const thirdParty = evaluate(
      side("v1", app()),
      side("v2", withRequest("lib/x.js", "https://ingest.other.example.net/e")),
      { options },
    );
    const firstParty = evaluate(
      side("v1", app()),
      side("v2", withRequest("lib/x.js", "https://api.acmenotes.example/v2")),
      { options },
    );
    const unresolved = evaluate(
      side("v1", app()),
      side("v2", withRequest("lib/x.js", null)),
      { options },
    );
    assert.equal(thirdParty[0].severity, "high");
    assert.equal(firstParty[0].severity, "low");
    assert.equal(unresolved[0].rule, "RW-N02");
  });

  it("finds a new host in a module that already sent requests", () => {
    const before = withRequest("lib/x.js", "https://api.acmenotes.example/v2");
    const after = withRequest("lib/x.js", "https://api.acmenotes.example/v2");
    after.urlLiterals.push(
      fact(
        "https://telemetry.other.example.net/t",
        {
          module: "lib/x.js",
          url: "https://telemetry.other.example.net/t",
          binding: "T",
        },
        at("lib/x.js", 2),
      ),
    );
    const findings = evaluate(side("v1", before), side("v2", after), {
      options: { vendorDomains: ["acmenotes.example"] },
    });
    assert.deepEqual(
      findings.map((finding) => finding.title),
      ["New third-party destination: telemetry.other.example.net"],
    );
  });

  it("does not report a known host again when its bundle is renamed", () => {
    const findings = evaluate(
      side(
        "v1",
        withRequest(
          "assets/index-4f9Kq2Lm.js",
          "https://api.other.example.net/x",
        ),
      ),
      side(
        "v2",
        withRequest(
          "assets/index-9pQe1VxR.js",
          "https://api.other.example.net/x",
        ),
      ),
    );
    assert.deepEqual(findings, []);
  });
});
