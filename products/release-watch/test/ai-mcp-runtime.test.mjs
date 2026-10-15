import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { app, at, evaluate, fact, range, rules, side } from "./helpers.mjs";

describe("AI rules", () => {
  const key = "sk-proj-DEMO-not-a-real-key-000000000000000000";

  it("masks a credential-shaped literal and grades browser code critical", () => {
    const right = app({
      browserModules: new Set(["assets/summary.js"]),
      stringLiterals: [
        fact(
          "assets/summary.js#KEY",
          { module: "assets/summary.js", value: key, binding: "KEY" },
          at("assets/summary.js", 1),
        ),
      ],
    });
    const [finding] = evaluate(side("v1", app()), side("v2", right));
    assert.equal(finding.rule, "RW-A02");
    assert.equal(finding.severity, "critical");
    assert.ok(
      !JSON.stringify(
        finding.evidence.map(({ redact: _redact, ...item }) => item),
      ).includes(key),
      "claims never hold the raw key",
    );
    assert.match(finding.evidence[0].claim, /sk-proj-…0000 \(46 characters\)/);
  });

  it("claims AI provider hosts so the generic network rule does not repeat them", () => {
    const right = app({
      endpoints: [
        fact(
          "https://api.openai.com/v1/chat/completions",
          {
            value: "https://api.openai.com/v1/chat/completions",
            mechanism: "call:fetch",
            candidate: false,
          },
          at("server/llm.js", 3),
        ),
      ],
    });
    assert.deepEqual(rules(evaluate(side("v1", app()), side("v2", right))), [
      "RW-A01",
    ]);
  });

  it("reports a changed prompt in a module that uses an AI SDK", () => {
    const module = "src/summarize.js";
    const ai = (text) =>
      app({
        modules: new Map([
          [
            module,
            {
              externalImports: new Set(["@anthropic-ai/sdk"]),
              local: new Set(),
              imported: new Map(),
            },
          ],
        ]),
        stringLiterals: [
          fact(
            `${module}#SYSTEM_PROMPT`,
            { module, value: text, binding: "SYSTEM_PROMPT" },
            at(module, 5),
          ),
        ],
      });
    const findings = evaluate(
      side(
        "v1",
        ai("You summarize a note in two sentences without personal data."),
      ),
      side(
        "v2",
        ai(
          "You summarize a note in two sentences and include the author's email address.",
        ),
      ),
    );
    assert.deepEqual(rules(findings), ["RW-A04"]);
  });
});

describe("MCP rules", () => {
  it("flags a tool whose handler contains new process execution and suppresses RW-P01", () => {
    const module = "src/mcp-server.js";
    const right = app({
      modules: new Map([
        [
          module,
          {
            externalImports: new Set([
              "@modelcontextprotocol/sdk/server/mcp.js",
            ]),
            local: new Set(),
            imported: new Map(),
          },
        ],
      ]),
      imports: [
        fact(
          "@modelcontextprotocol/sdk/server/mcp.js",
          { specifier: "@modelcontextprotocol/sdk/server/mcp.js", module },
          at(module, 1),
        ),
      ],
      memberCalls: [
        fact(
          `${module}#read:/registerTool`,
          { module, member: "registerTool", range: range(24, 0, 38, 2) },
          at(module, 24),
        ),
      ],
      childProcesses: [
        fact(
          `${module}#exec`,
          {
            module,
            method: "exec",
            command: null,
            range: range(33, 6, 33, 80),
          },
          at(module, 33),
        ),
      ],
    });
    const findings = evaluate(side("v1", app()), side("v2", right));
    assert.deepEqual(rules(findings), ["RW-A03", "RW-M01"]);
    assert.equal(
      findings.find((finding) => finding.rule === "RW-M01").severity,
      "critical",
    );
  });
});

describe("runtime capture rules", () => {
  const capture = (headers, cookie, credentials = []) => ({
    name: "web.har",
    exchanges: [],
    documents: [
      fact(
        "/",
        { origin: "https://app.example", path: "/", headers },
        { file: "web.har", line: null, column: null, record: 0 },
      ),
    ],
    cookies: [
      fact(
        "session",
        { host: "app.example", name: "session", ...cookie },
        { file: "web.har", record: 2 },
      ),
    ],
    credentials,
    apiGroups: [],
  });
  const strict = {
    "content-security-policy": "default-src 'self'",
    "strict-transport-security": "max-age=63072000",
  };

  it("grades a removed HSTS header high and a lost HttpOnly flag medium", () => {
    const findings = evaluate(
      side("v1", null, {
        capture: capture(strict, {
          http_only: true,
          secure: true,
          same_site: "Lax",
        }),
      }),
      side("v2", null, {
        capture: capture(
          { "content-security-policy": "default-src *" },
          { http_only: false, secure: true, same_site: "Lax" },
        ),
      }),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity]),
      [
        ["RW-H02", "high"],
        ["RW-H04", "medium"],
      ],
    );
  });

  it("flags a browser credential sent to an AI provider but not to the deployment's own API", () => {
    const credential = (host) =>
      fact(
        `${host}#header:authorization`,
        {
          host,
          origin: `https://${host}`,
          method: "POST",
          field: "header",
          name: "authorization",
          redacted_by_rea: true,
        },
        { file: "web.har", record: 7 },
      );
    const left = capture(strict, {
      http_only: true,
      secure: true,
      same_site: "Lax",
    });
    const right = capture(
      strict,
      { http_only: true, secure: true, same_site: "Lax" },
      [credential("api.openai.com"), credential("app.example")],
    );
    const findings = evaluate(
      side("v1", null, { capture: left }),
      side("v2", null, { capture: right }),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity]),
      [["RW-H03", "critical"]],
    );
  });
});
