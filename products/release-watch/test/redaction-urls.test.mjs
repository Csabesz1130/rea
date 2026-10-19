// URL parts, header text, caller-selected paths and the report boundary:
// claims and source lines give a part the same tag, tags stay stable when
// scrubbed again, and scrubbing is bounded. Every secret is an obvious fake.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  localPath,
  localText,
  scrubDeep,
  scrubLocalText,
  scrubText,
  sourceText,
} from "../src/redact.mjs";
import { displayLdflags } from "../src/rules/go.mjs";
import { sourceLine } from "../src/source-line.mjs";
import {
  displayPath,
  displayUrl,
  maskTag,
  scriptKey,
  scriptSourceUrl,
} from "../src/urls.mjs";

const TAG = /‹[0-9a-f]{6}›/g;
const shown = (line, needle, reading = {}) =>
  scrubDeep(
    sourceText(sourceLine(line, Math.max(0, line.indexOf(needle)), reading)),
  );
const tagsOf = (text) => text.match(TAG) ?? [];

describe("header text", () => {
  it("masks relative, fragment, bare-query and path-parameter report URIs and JWTs", () => {
    for (const [text, secret] of [
      ["report-uri csp/r/NOSLASHPATHTOKEN0abc123def456", "NOSLASHPATH"],
      ["report-uri csp-report#FRAGTOKEN0abc123def456", "FRAGTOKEN"],
      ["default-src 'self'; report-uri ?token=BAREQUERYTOKEN1", "BAREQUERY"],
      ["report-uri csp-report;jsessionid=JSESSIONSECRET0abc", "JSESSION"],
      ["report-uri /csp;token=FAKEtk0003/x", "FAKEtk"],
      [
        "report-uri eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.RkFLRVNJR05BVFVSRQ",
        "eyJyb2xl",
      ],
    ])
      assert.ok(!scrubText(text).includes(secret), scrubText(text));
    for (const text of [
      "script-src 'self' https://cdn.example.net; connect-src *",
      "text/html; charset=utf-8",
      "max-age=31536000; includeSubDomains; preload",
    ])
      assert.equal(scrubText(text), text);
  });

  it("gives a path parameter the tag its claim gives it", () => {
    const url = "https://n31.example/app/home;jsessionid=FAKEjs01?x=1";
    const claim = displayUrl(url);
    assert.match(claim, /^https:\/\/n31\.example\/app\/home;jsessionid=‹/);
    assert.deepEqual(tagsOf(shown(`fetch("${url}")`, "fetch(")), tagsOf(claim));
  });
});

describe("script sources and markup", () => {
  it("reads two leading slashes or backslashes as a protocol-relative host", () => {
    for (const source of [
      "\\\\cdn.q.example/qm.js",
      "/\\cdn.q.example/qm.js",
      "//cdn.q.example/qm.js",
    ])
      assert.equal(scriptSourceUrl(source), "https://cdn.q.example/qm.js");
    assert.equal(scriptSourceUrl("/qm.js"), null);
    assert.equal(scriptSourceUrl("\\qm.js"), null);
    assert.equal(
      scriptKey("\\\\CDN.Q.example/qm.js"),
      scriptKey("//cdn.q.example/qm.js"),
    );
  });

  it("joins a value across tab and line-break references in a src query, as the URL parser does", () => {
    const claim = displayUrl(
      "https://maps.x.example/js?callback=init&key=FAKEk3yTabRef51",
    );
    for (const separator of ["&Tab;", "&NewLine;", "&#9;", "&#10;", "\t"]) {
      const line = `<script src="//maps.x.example/js?callback=init&amp;key=FAKEk3y${separator}TabRef51"></script>`;
      const text = shown(line, "<script", { file: "index.html" });
      assert.deepEqual(tagsOf(text), tagsOf(claim), text);
      assert.ok(!/TabRef51|FAKEk3y/.test(text), text);
    }
  });

  it("decodes character references only in markup files", () => {
    const line = `fetch("https://g1.third.example/v1?a=1&amp;b=2")`;
    const claim = displayUrl("https://g1.third.example/v1?a=1&amp;b=2");
    const text = shown(line, "fetch(", { file: "src/g1.js" });
    assert.ok(text.includes("&amp;b=‹"), text);
    assert.deepEqual(tagsOf(text), tagsOf(claim));
  });
});

describe("relative specifiers and controls", () => {
  it("masks fragments of relative specifiers and a path after `:`", () => {
    for (const text of [
      "Service worker registration of sw.js#access_token=FAKEswFrag0002",
      "{u:/api?token=FAKEbrace01}",
      "registers ./sw.js;jsessionid=FAKEswJs0004",
    ])
      assert.ok(!scrubText(text).includes("FAKE"), scrubText(text));
    const line = `navigator.serviceWorker.register("sw.js#access_token=FAKEswFrag0002"); fetch(u)`;
    assert.ok(!shown(line, "fetch(").includes("FAKE"), shown(line, "fetch("));
  });

  it("encodes bidirectional and control characters in every report string", () => {
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(7);
    assert.deepEqual(
      scrubDeep({ title: `sw${rlo}gpj.js`, note: [`a${bell}b`] }),
      {
        title: "sw\\u202Egpj.js",
        note: ["a\\u0007b"],
      },
    );
  });
});

describe("hashed asset names", () => {
  it("keeps names that are only a content hash for static assets, and upper-case and underscore hashes", () => {
    for (const path of [
      "/js/a1b2c3d4e5f6a7b8c9d0e1f2.js",
      "/0a1b2c3d4e5f60718293a4b5c6d7e8f901234567.js",
      "/assets/main.9F8E7D6C5B4A39281706.js",
      "/assets/main_9f8e7d6c5b4a39281706.css",
    ])
      assert.equal(displayPath(path), path);
    assert.ok(
      !displayPath("/notify/0a1b2c3d4e5f60718293a4b5c6d7e8f9.json").includes(
        "0a1b",
      ),
    );
  });

  it("keeps bundler base64url and base32 hashes in claims, source lines and locations alike", () => {
    const names = [
      "dist/config-manager-DsRE1v6M.js",
      "dist/dependency-manager-BJq6jWA5.js",
      "dist/ai-services-unified-CsFt27lZ.js",
      "assets/index-B_7x-Qk2.js",
      "assets/chunk-AbC_EfGh.css",
      "_app/immutable/entry/start.BqU1RQ7V.js",
      // Vite names a chunk of a chunk with a second hash.
      "dist/lucideIconData-CKJ1do82-DtEQhFA7.mjs",
    ];
    for (const name of names) {
      assert.equal(scrubText(`spawn() in ${name}`), `spawn() in ${name}`);
      assert.equal(scrubDeep({ location: { file: name } }).location.file, name);
      const line = `import { x } from "./${name}";`;
      assert.equal(scrubDeep(sourceText(line)), line);
    }
    // A run longer than a bundler's 8-character hash, a run with no name
    // before it, a random-looking name before a hash, or a name that is no
    // static asset is still a token.
    for (const path of [
      "/v1/x-FAKEaB3dE5gH7jK9mN1pQ3rS5tU7.js",
      "/v1/FAKEaB3dE5gH7jK9mN1pQ3rS5tU7.js",
      "/api/users/john_FAKEaB3dE5gH7jK9.json",
      "/o/u_FAKEdEf2GhI4jKl6Mn.gif",
      "/share/report-FAKEx2LmQ8pZ7vR4tY1w.js",
      "/o/FAKE9dEf2GhI4_jKl6Mn8.gif",
    ]) {
      assert.ok(!scrubText(`GET ${path}`).includes("FAKE"), path);
      assert.ok(
        !scrubText(`GET https://t.mailer.example.net${path}`).includes("FAKE"),
        path,
      );
    }
  });
});

describe("tags", () => {
  it("masks a '+' path segment alone, as its claim does", () => {
    const url = "https://plus7.example/v1/aB3dE5gH7jK9+mN1pQ3rS5tU7/x";
    const text = shown(`fetch("${url}")`, "fetch(");
    assert.equal(text, `fetch("${displayUrl(url)}")`);
    assert.match(text, /\/v1\/‹[0-9a-f]{6}›\/x/);
  });

  it("treats tags as atomic, so a second scrub never re-tags", () => {
    const tagged = displayUrl("https://e.example/v1?a=1&b=FAKEQ");
    assert.equal(scrubText(tagged), tagged);
    assert.equal(scrubText(`see ${tagged}.`), `see ${tagged}.`);
    const [first, second] = tagsOf(tagged);
    assert.equal(maskTag(`${first}x${second}`).startsWith(first), true);
    assert.equal(maskTag(first), first);
    for (const escaped of ["\\u0026", "\\x26"]) {
      const text = shown(
        `fetch("https://e.example/v1?a=1${escaped}b=FAKEQ")`,
        "fetch(",
      );
      assert.equal(text, `fetch("${tagged}")`);
    }
  });

  it("tells every value apart, with six hex digits unless another value holds them", () => {
    const values = Array.from(
      { length: 20_000 },
      (_, index) => `value-${index}`,
    );
    const tags = values.map((value) => maskTag(value));
    assert.equal(new Set(tags).size, values.length);
    assert.deepEqual(
      values.slice(0, 50).map((value) => maskTag(value)),
      tags.slice(0, 50),
      "a value keeps its tag",
    );
    assert.ok(tags.every((tag) => /^‹(?:[0-9a-f]{2}){3,32}›$/.test(tag)));
    assert.ok(
      tags.filter((tag) => tag.length === 8).length > values.length * 0.99,
    );
  });
});

describe("bounded scrubbing", () => {
  it("scrubs a URL with 130,000 query pairs, tagging the rest of the query once", () => {
    const url = `https://x.example/p?${Array.from({ length: 130_000 }, (_, index) => `k${index}=v`).join("&")}`;
    const claim = displayUrl(url);
    assert.ok(claim.length < 1500, `${claim.length}`);
    assert.equal(scrubText(url), claim);
    const snippet = shown(`fetch("${url}")`, "fetch(");
    assert.ok(snippet.startsWith('fetch("'), snippet);
  });

  it("never shows user info whose scheme or host lies beyond the shown slice", () => {
    const password = `FAKEpw${"x".repeat(2300)}`;
    for (const line of [
      `fetch("https://admin:${password}@hooks.example.com/x")`,
      `fetch(\`https://\${u}:${password}@hooks.example.com/x\`)`,
      `fetch("https://admin:${password}@hooks.example.com/x");fetch(u)`,
    ]) {
      const text = shown(
        line,
        line.endsWith("fetch(u)") ? ";fetch(u)" : "fetch(",
      );
      assert.ok(!/FAKEpw|xxxxxxxx/.test(text), text);
    }
  });

  it("masks many distinct credentials in one pass, in linear time", () => {
    const keys = Array.from(
      { length: 20_000 },
      (_, index) => `sk-ant-api03-FAKE${String(index).padStart(24, "0")}`,
    );
    const started = performance.now();
    const text = scrubText(keys.join(" "));
    assert.ok(performance.now() - started < 2000);
    assert.ok(!text.includes("FAKE0000"), text.slice(0, 200));
    assert.equal(text.match(/\(41 characters\)/g).length, keys.length);
  });

  it("withholds a field whose scrubbing fails and keeps the others", () => {
    const failing = (text) => {
      if (text === "bad") throw new RangeError("Invalid string length");
      return text;
    };
    assert.deepEqual(scrubDeep({ a: "bad", b: ["ok"] }, failing), {
      a: "‹withheld: masking failed›",
      b: ["ok"],
    });
  });
});

describe("caller-selected paths", () => {
  const root =
    "/tmp/rw-123e4567-e89b-42d3-a456-426614174000/aB3dE5gH7jK9mN1pQ3rS5tU7";

  it("keeps input, Evidence and output paths and local paths in errors as given", () => {
    const report = scrubDeep({
      input: localPath(root),
      evidence_file: localPath("evidence/app-left-application.json"),
      message: localText(`Nothing to analyze at ${root}/old: no package.json.`),
      coverage: localText({
        gaps: [
          `Files at the per-file node ceiling: src/${"aB3dE5gH7jK9mN1pQ3rS5tU7"}.js.`,
        ],
      }),
    });
    assert.equal(report.input, root);
    assert.equal(report.evidence_file, "evidence/app-left-application.json");
    assert.equal(
      report.message,
      `Nothing to analyze at ${root}/old: no package.json.`,
    );
    assert.ok(
      report.coverage.gaps[0].includes("src/aB3dE5gH7jK9mN1pQ3rS5tU7.js"),
    );
  });

  it("still masks credential formats and URL secrets beside a path", () => {
    const key = "sk-ant-api03-FAKEpathkey0000000000000000";
    assert.equal(
      scrubDeep(localPath(`${root}/${key}`)),
      `${root}/sk-ant-…0000 (40 characters)`,
    );
    const message = scrubLocalText(
      `REA failed for ${root}: GET https://x.example/v1?token=FAKEq1`,
    );
    assert.ok(message.includes(root) && !message.includes("FAKEq1"), message);
  });
});

describe("linker flags", () => {
  it("masks `--X` and adjacent quoted `-X` fields", () => {
    assert.equal(
      displayLdflags(
        `-s "--X" "main.token=Bearer FAKEdoubledash0123456" -X main.endpoint=https://t.example/v1`,
      ),
      `-s "--X" "main.token=… (28 characters)" -X main.endpoint=https://t.example/v1`,
    );
    assert.equal(
      displayLdflags(
        `-s "-X""main.token=FAKEadjacent0123" --X main.v=FAKEbare`,
      ),
      `-s "-X""main.token=… (16 characters)" --X main.v=… (8 characters)`,
    );
  });
});
