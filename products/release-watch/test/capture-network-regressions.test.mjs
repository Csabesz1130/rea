// Network destination and runtime capture semantics the fixture releases do
// not exercise: browser calls to known providers, namespaces, CSP nonces,
// cookie strength and captures on one side only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { headerChanges } from "../src/rules/runtime.mjs";
import { app, at, evaluate, fact, range, rules, side } from "./helpers.mjs";

// Capture facts with only the families a test sets.
const captureWith = (name, families) => ({
  name,
  startHosts: ["app.example"],
  limitations: [],
  gaps: [],
  exchanges: [],
  documents: [],
  cookies: [],
  credentials: [],
  apiGroups: [],
  ...families,
});

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

describe("security header comparison", () => {
  const CSP = "content-security-policy";
  const HSTS = "strict-transport-security";
  const changed = (name, was, now) =>
    headerChanges({ [name]: was }, { [name]: now }).map(
      (change) => change.name,
    );
  const policy =
    "default-src 'self'; script-src 'self' https://cdn.acme.example";

  it("treats policies browsers apply the same as unchanged", () => {
    for (const now of [
      "default-src 'self'; script-src 'self' https://cdn.acme.example 'self'",
      "default-src 'self'; script-src 'SELF' https://CDN.acme.example 'self'",
      "Script-Src HTTPS://cdn.acme.example 'self'; default-src 'self'; script-src *",
    ])
      assert.deepEqual(changed(CSP, policy, now), [], now);
    for (const now of [
      "max-age=63072000; preload; includeSubDomains",
      'MAX-AGE="63072000"; INCLUDESUBDOMAINS; preload',
    ])
      assert.deepEqual(
        changed(HSTS, "max-age=63072000; includeSubDomains; preload", now),
        [],
        now,
      );
  });

  it("still reports a change in a case-sensitive path, hash or directive", () => {
    assert.deepEqual(
      changed(
        CSP,
        "script-src https://cdn.acme.example/Lib/",
        "script-src https://cdn.acme.example/lib/",
      ),
      [CSP],
    );
    assert.deepEqual(
      changed(CSP, "script-src 'sha256-AbC='", "script-src 'sha256-abc='"),
      [CSP],
    );
    assert.deepEqual(changed(CSP, policy, `${policy} https:`), [CSP]);
    assert.deepEqual(
      changed(HSTS, "max-age=63072000; includeSubDomains", "max-age=63072000"),
      [HSTS],
    );
  });

  it("reports the equivalent policies of a real capture pair as unchanged", () => {
    const pageWith = (headers) =>
      captureWith("x.har", {
        documents: [
          fact(
            "/",
            { host: "app.example", path: "/", display_path: "/", headers },
            { file: "x.har", record: 0 },
          ),
        ],
      });
    const findings = evaluate(
      side("v1", null, {
        capture: pageWith({
          [CSP]: policy,
          [HSTS]: "max-age=1; preload; includeSubDomains",
        }),
      }),
      side("v2", null, {
        capture: pageWith({
          [CSP]:
            "script-src https://CDN.acme.example 'SELF'; default-src 'self'",
          [HSTS]: "includesubdomains; Preload; max-age=1",
        }),
      }),
    );
    assert.deepEqual(rules(findings), []);
  });
});

describe("runtime cookies", () => {
  const cookies = (...attributes) =>
    attributes.map((entry, record) =>
      fact(
        "session",
        {
          host: "app.example",
          domain: "app.example",
          name: "session",
          ...entry,
        },
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

  const sameSite = (before, after) =>
    evaluate(
      side("v1", null, {
        capture: capture(cookies({ ...strong, same_site: before })),
      }),
      side("v2", null, {
        capture: capture(cookies({ ...strong, same_site: after })),
      }),
    );
  const strong = { http_only: true, secure: true };

  it("reports SameSite Lax to unset with the browsers' differing default", () => {
    const [finding] = sameSite("Lax", null);
    assert.equal(finding.rule, "RW-H04");
    assert.equal(finding.severity, "medium");
    assert.equal(finding.title, "Cookie session lost SameSite=Lax");
    assert.match(finding.evidence[1].claim, /SameSite not set/);
    assert.match(
      finding.unknowns.join(" "),
      /Chrome treats it as Lax after a short grace period/,
    );
    assert.doesNotMatch(JSON.stringify(finding), /Lax in current browsers/);
  });

  it("grades unset SameSite against both browser defaults", () => {
    const outcome = (before, after) =>
      sameSite(before, after).map((finding) => finding.title);
    assert.deepEqual(outcome("Strict", null), [
      "Cookie session lost SameSite=Strict",
    ]);
    assert.deepEqual(outcome(null, "None"), [
      "Cookie session lost browser-default SameSite",
    ]);
    assert.deepEqual(outcome(null, "Lax"), []);
    assert.deepEqual(outcome("None", null), []);
    assert.deepEqual(outcome(null, null), []);
    assert.deepEqual(outcome("Strict", "Bogus"), []);
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

describe("cleartext requests in a capture", () => {
  const exchange = (url, method, status) => {
    const parsed = new URL(url);
    return fact(
      parsed.hostname,
      {
        host: parsed.hostname,
        origin: parsed.origin,
        method,
        path: parsed.pathname,
        status,
        mime: "text/html",
      },
      { file: "web.har", record: 0 },
    );
  };
  const site = "https://app.example/";
  const cleartext = (method, status) =>
    rules(
      evaluate(
        side("v1", null, {
          capture: captureWith("web.har", {
            exchanges: [exchange(site, "GET", 200)],
          }),
        }),
        side("v2", null, {
          capture: captureWith("web.har", {
            exchanges: [
              exchange(site, "GET", 200),
              exchange("http://app.example/api/session", method, status),
            ],
          }),
        }),
      ),
    );

  it("reports a credential POST the server redirected", () => {
    assert.deepEqual(cleartext("POST", 302), ["RW-N03"]);
  });

  it("does not report a redirected GET, the usual upgrade to https://", () => {
    assert.deepEqual(cleartext("GET", 301), []);
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
