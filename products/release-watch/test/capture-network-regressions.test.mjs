// Network destination and runtime capture semantics the fixture releases do
// not exercise: browser calls to known providers, namespaces, CSP nonces,
// cookie strength and captures on one side only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { app, at, evaluate, fact, range, rules, side } from "./helpers.mjs";

describe("destinations and headers", () => {
  it("reports browser code calling an AI provider that only the old server called", () => {
    const openai = "https://api.openai.com/v1/chat/completions";
    const endpoint = (file) =>
      fact(
        openai,
        { value: openai, mechanism: "call:fetch", candidate: false },
        at(file, 3),
      );
    const server = side("v1", app({ endpoints: [endpoint("server.js")] }));
    const browser = side(
      "v2",
      app({
        endpoints: [endpoint("server.js"), endpoint("assets/app.js")],
        browserModules: new Set(["assets/app.js"]),
      }),
    );
    const findings = evaluate(server, browser);
    assert.deepEqual(rules(findings), ["RW-A01"]);
    assert.match(findings[0].title, /Browser code calls OpenAI directly/);
  });

  it("ignores XML namespace URLs next to an unresolved request", () => {
    const request = fact(
      "ui.js#fetch",
      {
        module: "ui.js",
        method: "fetch",
        endpoint: null,
        range: range(4, 0, 4, 20),
      },
      at("ui.js", 4),
    );
    const svg = "http://www.w3.org/2000/svg";
    const findings = evaluate(
      side("v1", app({ requests: [request] })),
      side(
        "v2",
        app({
          requests: [request],
          urlLiterals: [
            fact(
              svg,
              { module: "ui.js", url: svg, value: svg, binding: "SVG_NS" },
              at("ui.js", 1),
            ),
          ],
        }),
      ),
    );
    assert.deepEqual(rules(findings), []);
  });

  it("does not report a CSP whose only change is its per-response nonce", () => {
    const page = (nonce) =>
      fact(
        "/",
        {
          origin: "https://app.example",
          host: "app.example",
          path: "/",
          display_path: "/",
          headers: {
            "content-security-policy": `script-src 'self' 'nonce-${nonce}'`,
          },
        },
        { file: "x.har", record: 0 },
      );
    const capture = (nonce) => ({
      name: "x.har",
      startHosts: ["app.example"],
      limitations: [],
      gaps: [],
      exchanges: [],
      documents: [page(nonce)],
      cookies: [],
      credentials: [],
      apiGroups: [],
    });
    assert.deepEqual(
      rules(
        evaluate(
          side("v1", null, { capture: capture("q8Zr1kP0") }),
          side("v2", null, { capture: capture("Lf4Yb9sN") }),
        ),
      ),
      [],
    );
  });
});

describe("runtime cookies", () => {
  const cookies = (...attributes) =>
    attributes.map((entry, record) =>
      fact(
        "session",
        { host: "app.example", name: "session", ...entry },
        { file: "web.har", record },
      ),
    );
  const capture = (facts) => ({
    name: "web.har",
    startHosts: ["app.example"],
    limitations: [],
    exchanges: [],
    documents: [],
    cookies: facts,
    credentials: [],
    apiGroups: [],
  });

  it("grades the weakest Set-Cookie of each name", () => {
    const strong = { http_only: true, secure: true, same_site: "Lax" };
    const findings = evaluate(
      side("v1", null, { capture: capture(cookies(strong, strong)) }),
      side("v2", null, {
        capture: capture(cookies(strong, { ...strong, http_only: false })),
      }),
    );
    assert.deepEqual(rules(findings), ["RW-H04"]);
  });
});

describe("one-sided captures", () => {
  it("grades a browser credential sent to an AI provider without an old capture", () => {
    const credential = fact(
      "api.openai.com#header:authorization",
      {
        host: "api.openai.com",
        origin: "https://api.openai.com",
        method: "POST",
        field: "header",
        name: "authorization",
        redacted_by_rea: true,
      },
      { file: "new.har", record: 3 },
    );
    const capture = {
      name: "new.har",
      startHosts: ["app.example"],
      limitations: [],
      exchanges: [],
      documents: [],
      cookies: [],
      credentials: [credential],
      apiGroups: [],
    };
    const findings = evaluate(
      side("v1", app()),
      side("v2", app(), { capture }),
    );
    assert.deepEqual(rules(findings), ["RW-C02", "RW-H03"]);
    assert.match(
      findings.find((finding) => finding.rule === "RW-H03").evidence[0].claim,
      /no capture of v1 to compare/,
    );
  });
});
