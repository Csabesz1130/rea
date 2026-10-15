// The redaction and escaping boundary, and manifest validation.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { discoverRelease } from "../src/discover.mjs";
import { markdownText, printable, scrubText } from "../src/redact.mjs";
import { renderMarkdown } from "../src/report/markdown.mjs";
import { displayLdflags } from "../src/rules/go.mjs";

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

  it("masks every -X linker value", () => {
    const flags = displayLdflags(
      "-s -w -X main.endpoint=https://t.example.net/c?k=abc -X 'main.token=s3cr3t'",
    );
    assert.equal(
      flags,
      "-s -w -X main.endpoint=https://t.example.net/c?k=… -X 'main.token=… (6 characters)'",
    );
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
