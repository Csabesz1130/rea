// The redaction and escaping boundary, and manifest validation.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { discoverRelease } from "../src/discover.mjs";
import {
  markdownText,
  printable,
  scrubSource,
  scrubText,
} from "../src/redact.mjs";
import { renderMarkdown } from "../src/report/markdown.mjs";
import { displayLdflags } from "../src/rules/go.mjs";
import { displayUrl } from "../src/urls.mjs";

const key = "sk-proj-DEMO-not-a-real-key-000000000000000000";

describe("redaction", () => {
  it("masks credential tokens and URL secrets anywhere in a text", () => {
    const text = scrubText(
      `token ${key} sent to https://user:pw@hooks.example.com/bot123456:ABCdef/send?chat=42`,
    );
    assert.ok(!text.includes(key));
    assert.ok(
      !text.includes("pw@") &&
        !text.includes("chat=42") &&
        !text.includes("ABCdef"),
    );
    assert.match(text, /sk-proj-…0000 \(46 characters\)/);
  });

  it("masks every -X linker value, including quoted values with spaces", () => {
    const flags = displayLdflags(
      "-s -w -X main.endpoint=https://t.example.net/c?k=abc -X 'main.token=Bearer s3cr3tvalue' -X \"main.mode=fast\"",
    );
    assert.match(
      flags,
      /^-s -w -X main\.endpoint=https:\/\/t\.example\.net\/c\?k=‹[0-9a-f]{4}› /,
    );
    assert.ok(
      flags.endsWith(
        "-X 'main.token=… (18 characters)' -X \"main.mode=… (4 characters)\"",
      ),
    );
    assert.ok(!flags.includes("s3cr3t"));
  });

  it("keeps terminal lines and Markdown free of controls and markup", () => {
    assert.equal(printable("a\nb\u001b[2Jc\u202e"), "a b [2Jc ");
    assert.equal(
      markdownText("x\n## PASS <!-- [a](b)"),
      "x ## PASS &lt;!-- \\[a\\](b)",
    );
    assert.equal(markdownText("# PASS"), "\\# PASS");
  });

  it("renders a hostile title as one escaped line", () => {
    const markdown = renderMarkdown({
      product: "Acme",
      labels: { left: "v1", right: "v2" },
      verdict: {
        decision: "block",
        counts: { critical: 1, high: 0, medium: 0, low: 0 },
      },
      components: [],
      errors: [],
      findings: [
        {
          id: "F1",
          severity: "critical",
          title: "x\n\n**PASS** <!--",
          summary: "s",
          evidence: [],
          unknowns: [],
          recommendation: "r",
          component: "app",
        },
      ],
      run: { rea_calls: [], elapsed_ms: 0, llm_tokens: 0 },
    });
    assert.ok(!markdown.includes("<!--"));
    assert.ok(markdown.includes("x  \\*\\*PASS\\*\\* &lt;!--"));
  });
});

describe("release manifests", () => {
  const release = (components) => {
    const root = mkdtempSync(path.join(tmpdir(), "rw-manifest-"));
    mkdirSync(path.join(root, "web"));
    writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
    writeFileSync(
      path.join(root, "release-watch.json"),
      JSON.stringify({ components }),
    );
    return root;
  };

  it("rejects names that cannot be file names, duplicates and paths outside the release", () => {
    assert.throws(
      () => discoverRelease(release([{ name: "../web", path: "web" }])),
      /component name/,
    );
    assert.throws(
      () =>
        discoverRelease(
          release([
            { name: "web", path: "web" },
            { name: "web", path: "web" },
          ]),
        ),
      /listed twice/,
    );
    assert.throws(
      () => discoverRelease(release([{ name: "web", path: "../.." }])),
      /outside the release/,
    );
    assert.equal(
      discoverRelease(release([{ name: "web", path: "web" }])).components[0]
        .target.kind,
      "web-build",
    );
  });
});

describe("URL display", () => {
  it("leaves URLs with nothing to mask exactly as written, including in header values", () => {
    const csp = "script-src 'self' https://cdn.example.net; connect-src *";
    assert.equal(scrubText(csp), csp);
    assert.equal(
      scrubText("POST https://api.openai.com carries x"),
      "POST https://api.openai.com carries x",
    );
    assert.equal(
      scrubText("see https://app.example/cb#access_token=abc."),
      "see https://app.example/cb#….",
    );
  });
});

describe("source line scrubbing", () => {
  it("masks secrets hidden by escapes, inline headers and query pairs outside absolute URLs", () => {
    const lines = [
      String.raw`const KEYS = "primary:\nsk-ant-api03-NEWLINEPRECEDEDSECRETNEWLINEPRE42";`,
      `headers: { Authorization: "Bearer 9f8e7d6c5b4a39281706NONCATALOGBEARER" }`,
      "fetch(`${BASE}/v1/search?apikey=7f3a9c2e5b1d4f6a8c0e2b4d6f8a0c2e&q=${q}`)",
      `fetch("http://[fd00::17]:8080/api/v1/push?token=FAKEtoken0123456789")`,
    ];
    for (const line of lines)
      assert.ok(
        !/SECRET|NONCATALOG|7f3a9c2e|FAKEtoken/.test(scrubSource(line)),
        scrubSource(line),
      );
    assert.equal(
      scrubSource('const SYNC = "https://api.acmenotes.example/v2/sync";'),
      'const SYNC = "https://api.acmenotes.example/v2/sync";',
    );
  });

  it("keeps commit SHAs and tells masked values apart", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.ok(
      displayUrl(`https://raw.example.com/acme/w/${sha}/dist/w.js`).includes(
        sha,
      ),
    );
    assert.notEqual(
      displayUrl("https://cdn.x/chart.js?v=4.4.1"),
      displayUrl("https://cdn.x/chart.js?v=4.4.2"),
    );
    assert.ok(
      !displayUrl(
        "https://h.example/hook/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc123DEF456ghi789",
      ).includes("eyJ"),
    );
  });
});

describe("manifest shapes", () => {
  const write = (manifest) => {
    const root = mkdtempSync(path.join(tmpdir(), "rw-shape-"));
    mkdirSync(path.join(root, "web"));
    writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
    writeFileSync(
      path.join(root, "release-watch.json"),
      JSON.stringify(manifest),
    );
    return root;
  };

  it("names the file for a null manifest and rejects a capture that is not a path or a name repeated in another case", () => {
    assert.throws(
      () => discoverRelease(write(null)),
      /release-watch\.json must be a JSON object/,
    );
    assert.throws(
      () =>
        discoverRelease(
          write({ components: [{ name: "web", path: "web", capture: 5 }] }),
        ),
      /capture.*not a path/,
    );
    assert.throws(
      () =>
        discoverRelease(
          write({
            components: [
              { name: "web", path: "web" },
              { name: "WEB", path: "web" },
            ],
          }),
        ),
      /listed twice/,
    );
  });
});
