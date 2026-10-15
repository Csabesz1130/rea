// Destinations Release Watch attributes from REA's facts across modules: a
// URL constant another module exports, and URLs in modules whose requests go
// through an HTTP client REA does not model.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { app, at, evaluate, fact, range, side } from "./helpers.mjs";

const OPENAI = "https://api.openai.com/v1/chat/completions";
const LOCAL = "http://127.0.0.1:11434/api/generate";

// client.js imports MODEL_URL from config.js and fetches it.
const constants = (url) =>
  app({
    modules: new Map([
      [
        "src/client.js",
        {
          externalImports: new Set(),
          local: new Set(["src/config.js"]),
          imported: new Map([
            ["MODEL_URL", { module: "src/config.js", name: "MODEL_URL" }],
          ]),
          exports: new Map(),
          reexports: new Map(),
          stars: new Set(),
        },
      ],
    ]),
    requests: [
      fact(
        "src/client.js#fetch",
        {
          module: "src/client.js",
          method: "fetch",
          endpoint: null,
          range: range(3, 10, 3, 60),
        },
        at("src/client.js", 3),
      ),
    ],
    urlLiterals: [
      fact(
        url,
        { module: "src/config.js", url, value: url, binding: "MODEL_URL" },
        at("src/config.js", 1),
      ),
    ],
    bindingReads: [
      fact(
        "src/client.js#MODEL_URL",
        {
          module: "src/client.js",
          name: "MODEL_URL",
          range: range(3, 16, 3, 25),
          binding_range: range(1, 8, 1, 17),
          binding_owner: null,
        },
        at("src/client.js", 3),
      ),
    ],
  });

// One module that imports axios and holds a URL literal; REA saw no request.
const client = (url) =>
  app({
    imports: [
      fact(
        "axios",
        { specifier: "axios", module: "src/api.js" },
        at("src/api.js", 1),
      ),
    ],
    urlLiterals: [
      fact(
        url,
        { module: "src/api.js", url, value: url, binding: "BASE" },
        at("src/api.js", 2),
      ),
    ],
  });

describe("destinations across modules", () => {
  it("attributes a request to a URL constant another module exports", () => {
    const findings = evaluate(
      side("v1", constants(LOCAL)),
      side("v2", constants(OPENAI)),
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.rule === "RW-A01" && /api\.openai\.com/.test(finding.title),
      ),
      findings.map((finding) => finding.title).join("; "),
    );
  });

  it("takes a URL next to an unmodeled HTTP client as a medium guess", () => {
    const findings = evaluate(
      side("v1", client("https://api.vendor-a.example/v1")),
      side("v2", client("https://collect.vendor-b.example/v1")),
    ).filter((finding) => finding.rule === "RW-N01");
    assert.deepEqual(
      findings.map((finding) => [finding.severity, finding.title]),
      [["medium", "New third-party destination: collect.vendor-b.example"]],
    );
  });

  it("grades a guessed AI provider destination medium and says it may receive data", () => {
    const [finding] = evaluate(
      side("v1", client(LOCAL)),
      side("v2", client(OPENAI)),
    ).filter((item) => item.rule === "RW-A01");
    assert.deepEqual(
      [finding.severity, finding.title],
      ["medium", "New AI provider may receive data: OpenAI (api.openai.com)"],
    );
    assert.match(finding.summary, /holds a URL for OpenAI/);
  });
});
