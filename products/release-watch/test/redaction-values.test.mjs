// Values in source lines: credential-like names in common JavaScript forms,
// values written as concatenated pieces, random-looking runs against
// readable names, and sensitive lines. Every secret is an obvious fake.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrubDeep, sourceText } from "../src/redact.mjs";
import { continuation, sourceLine } from "../src/source-line.mjs";
import { hasRandomRun } from "../src/path-tokens.mjs";

// The snippet as report.json prints it.
const shown = (line, needle = "fetch(", reading = {}) =>
  scrubDeep(
    sourceText(sourceLine(line, Math.max(0, line.indexOf(needle)), reading)),
  );

const assertCase = ([line, secrets, kept = []], reading = {}) => {
  const text = shown(line, "fetch(", reading);
  for (const secret of secrets)
    assert.ok(!text.includes(secret), `${secret} shown in ${text}`);
  for (const part of ["fetch(", ...kept])
    assert.ok(text.includes(part), `${part} lost from ${text}`);
};

describe("source lines: values after credential-like names", () => {
  it("masks bracketed keys, fallbacks, Basic btoa, setters and call arguments", () => {
    for (const item of [
      [
        `h["x-api-key"] = "FAKEbr77"; fetch(u)`,
        ["FAKEbr77"],
        [`h["x-api-key"] = "‹`],
      ],
      [`cfg["password"] = "FAKEbr12"; fetch(u)`, ["FAKEbr12"]],
      [`e['api-key']='FAKEbr78';fetch(u)`, ["FAKEbr78"]],
      [
        `const API_KEY = process.env.API_KEY || "dev-FAKE-123"; fetch(u)`,
        ["dev-FAKE"],
        ["process.env.API_KEY || "],
      ],
      [`const token = process.env.T ?? "FAKEtok77"; fetch(u)`, ["FAKEtok77"]],
      [
        `const password = dev ? "FAKEdev12" : "FAKEprod12"; fetch(u)`,
        ["FAKEdev12", "FAKEprod12"],
      ],
      [
        `fetch(u, { headers: { Authorization: "Basic " + btoa("admin:FAKEpw99") } })`,
        ["FAKEpw99"],
        ['"Basic " + btoa('],
      ],
      [`setPassword("FAKEcall12"); fetch(u)`, ["FAKEcall12"], ["setPassword("]],
      [`h.set("X-Api-Key", "FAKE" + "spl1t7"); fetch(u)`, ['"FAKE"', "spl1t7"]],
      [`u.searchParams.set("appid", "FAKEappid8"); fetch(u)`, ["FAKEappid8"]],
      [
        `fetch(u, { params: { appid: "FAKEappid77", client_id: "FAKEcid1", sig: "FAKEsig1" } })`,
        ["FAKEappid77", "FAKEcid1", "FAKEsig1"],
      ],
    ])
      assertCase(item);
  });

  it("masks unquoted values in comments, template text and literals mixing letters and digits", () => {
    for (const item of [
      [`fetch(u); // token: FAKEcmt`, ["FAKEcmt"]],
      [`fetch(u); /* password: FAKEcmtBlock */`, ["FAKEcmtBlock"], ["*/"]],
      [`fetch(u); // password=FAKEpwC`, ["FAKEpwC"]],
      ["const s = `password: letmein`; fetch(u)", ["letmein"]],
      ["user: admin, password: FAKEyml99`; fetch(u)", ["FAKEyml99"]],
      [`DB_PASSWORD: FAKEyaml12 fetch(u)`, ["FAKEyaml12"]],
    ])
      assertCase(item);
  });

  it("keeps code that reads a secret, a template's interpolations and other names readable", () => {
    for (const line of [
      `fetch(u, { token: getToken(), apiKey: process.env.KEY, key: item.id })`,
      "fetch(u, { headers: { Authorization: `Bearer ${token}` } })",
      "fetch(u, { headers: { Authorization: `token ${GH}` } })",
      `const signal = "SIGTERM"; const design = "flat"; fetch(u)`,
      `const check = (token) => token ? "yes" : "no"; fetch(u)`,
    ])
      assert.equal(shown(line), line);
  });
});

describe("source lines: values written as pieces", () => {
  it("masks a string after `?name=`, `&name=` or `name=` pieces and one ending user info", () => {
    for (const item of [
      [
        `fetch("https://b9.third.example/v1/data?key=".concat("FAKEcc9x"))`,
        ["FAKEcc9x"],
        ["https://b9.third.example/v1/data?key="],
      ],
      [
        `fetch(["https://b5.third.example/v1/data", "?token=", "FAKEjn5x"].join(""))`,
        ["FAKEjn5x"],
        [`"?token=", "‹`],
      ],
      [
        `fetch("https://b4.third.example/v1/data?".concat("api_key", "=", "FAKEcc4x"))`,
        ["FAKEcc4x"],
        [`.concat("api_key", "=", "‹`],
      ],
      [
        `fetch("https://" + u + ":FAKEcatpw47@hooks.third.example/hook")`,
        ["FAKEcatpw47"],
        [`":‹`, "@hooks.third.example/hook"],
      ],
    ])
      assertCase(item);
  });
});

describe("random-looking runs", () => {
  const readable = [
    "sendAnalyticsEventV2Async",
    "@aws-sdk/client-route-53-domains",
    "Route53DomainsClient",
    "route53-sync-agent2",
    "claude-3-5-sonnet-20241022",
    "getting-started-guide-2024",
    "helper-v2-amd64-linux",
    "updater2024-x86_64",
    "XMLHttpRequestEventTarget",
    "getElementsByTagNameNS",
    "gpt-4o-mini-2024-07-18",
    "HTTP_PROXY_AUTHORIZATION",
  ];
  const random = [
    "aB3dE5gH7jK9mN1pQ3rS5tU7",
    "9f8e7d6c5b4a39281706",
    "550e8400-e29b-41d4-a716-446655440000",
    "ZmFrZXVzZXI6ZmFrZXBhc3M",
    "NOSLASHPATHTOKEN0abc123def456",
    "MAGICLINKSECRET0123456789",
    "kqzt8vwx2mnbp9rtyu4cxz",
    "Q8ZK2MWX7PTR4NVB9YHC",
    "npm_FAKEfake0123456789abcdef",
  ];

  it("reads word-like pieces as names and base62, base64, hex and UUIDs as tokens", () => {
    for (const value of readable)
      assert.equal(hasRandomRun(value), false, value);
    for (const value of random) assert.equal(hasRandomRun(value), true, value);
  });

  it("keeps identifiers, package names, paths and model ids readable in source lines", () => {
    for (const line of [
      `export const start = () => spawn("/usr/local/bin/helper-v2-amd64-linux", ["--port", "8080"]);`,
      `const sendAnalyticsEventV2Async = (u) => fetch(u, { method: "POST" });`,
      `import { Route53DomainsClient } from "@aws-sdk/client-route-53-domains";`,
      `fetch(u, { model: "claude-3-5-sonnet-20241022", guide: "getting-started-guide-2024", agent: "route53-sync-agent2" })`,
    ])
      assert.equal(sourceLine(line), line);
    const text = shown(`const k = "aB3dE5gH7jK9mN1pQ3rS5tU7"; fetch(u)`);
    assert.ok(!text.includes("aB3dE5gH"), text);
  });

  it("reads ternaries as code, not queries, also when the report scrubs the line again", () => {
    for (const line of [
      `export function f(a,b,c){return a?b=1:c,fetch("https://tern7.example/x")}`,
      `export function g(n,t,e){let r;r=n/2?t=1:e,fetch("https://tern8.example/y");return r}`,
    ])
      assert.equal(shown(line), line);
  });
});

describe("source lines: sensitive lines", () => {
  const sensitive = { sensitive: true };

  it("keeps URL hosts and paths, HTTP methods and header names, and masks other strings", () => {
    const line = `const k="AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000001";export const b=()=>fetch("https://telemetry.vendor-x.example/collect?u=FAKEq1",{method:"POST",headers:{"x-api-key":k},body:"FAKEbody99"});`;
    const text = shown(line, "fetch(", sensitive);
    for (const part of [
      'fetch("https://telemetry.vendor-x.example/collect?u=‹',
      'method:"POST"',
      '"x-api-key":k',
    ])
      assert.ok(text.includes(part), `${part} lost from ${text}`);
    for (const secret of ["FAKEq1", "FAKEbody99", "FAKEFAKEFAKE"])
      assert.ok(!text.includes(secret), `${secret} shown in ${text}`);
  });

  it("masks a template's literal parts and the strings inside its interpolations", () => {
    const line =
      'const GH = `ghp_FAKE${"0123456789ab"}${"cdefABCDEF01"}23456789`; fetch(u)';
    const text = shown(line, "fetch(", sensitive);
    assert.match(text, /^const GH = `‹[0-9a-f]{6}›\$\{"‹[0-9a-f]{6}›"\}/);
    for (const secret of [
      "ghp_FAKE",
      "0123456789ab",
      "cdefABCDEF01",
      "23456789",
    ])
      assert.ok(!text.includes(secret), `${secret} shown in ${text}`);
  });

  it("carries a sensitive line on through `+`, `,`, `[`, `(` and template literals", () => {
    assert.equal(continuation(`const K = "sk-ant-api03-FAKE" +`).operand, true);
    for (const line of [`f(a,`, `x = [`, `call(`])
      assert.equal(continuation(line).operand, true, line);
    assert.equal(continuation(`const CFG = \`[auth]`).template, true);
    assert.equal(continuation(`user: admin`, true).template, true);
    assert.equal(continuation("password: x`;", true).template, false);
    assert.equal(continuation(`fetch(u);`).operand, false);
  });
});
