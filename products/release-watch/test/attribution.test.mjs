// Destinations Release Watch attributes from REA's facts across modules: a
// URL constant another module exports, and URLs in modules whose requests go
// through an HTTP client REA does not model.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { releaseBaseline } from "../src/policy.mjs";
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
    bindings: [
      {
        module: "src/config.js",
        name: "MODEL_URL",
        range: range(1, 13, 1, 22),
        owner: null,
      },
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
      [
        [
          "medium",
          "Possible new third-party destination: collect.vendor-b.example",
        ],
      ],
    );
    assert.match(
      findings[0].why,
      /did not see a request to this host, only its URL/,
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
    assert.match(finding.why, /did not see a request to OpenAI, only its URL/);
  });
});

// A server module that calls OpenAI, and a page script that holds an
// OpenAI URL next to a request REA could not resolve (a guess), or calls it.
const browserApp = ({ guess = false, call = false } = {}) =>
  app({
    browserModules: new Set(["assets/settings.js"]),
    requests: [
      fact(
        "src/server.js#fetch",
        {
          module: "src/server.js",
          method: "fetch",
          endpoint: OPENAI,
          range: range(2, 10, 2, 60),
        },
        at("src/server.js", 2),
      ),
      ...(guess || call
        ? [
            fact(
              "assets/settings.js#fetch",
              {
                module: "assets/settings.js",
                method: "fetch",
                endpoint: null,
                range: range(4, 10, 4, 60),
              },
              at("assets/settings.js", 4),
            ),
          ]
        : []),
      ...(call
        ? [
            fact(
              "assets/settings.js#fetch",
              {
                module: "assets/settings.js",
                method: "fetch",
                endpoint: OPENAI,
                range: range(5, 10, 5, 60),
              },
              at("assets/settings.js", 5),
            ),
          ]
        : []),
    ],
    urlLiterals:
      guess || call
        ? [
            fact(
              "https://api.openai.com/v1",
              {
                module: "assets/settings.js",
                url: "https://api.openai.com/v1",
                value: "https://api.openai.com/v1",
                binding: "DEFAULT_BASE",
              },
              at("assets/settings.js", 1),
            ),
          ]
        : [],
  });

describe("AI provider calls from browser code", () => {
  const providers = (before, after) =>
    evaluate(side("v1", before), side("v2", after)).filter(
      (finding) => finding.rule === "RW-A01",
    );

  it("words a provider URL browser code only holds near requests as a possible call", () => {
    const [finding, ...rest] = providers(
      browserApp(),
      browserApp({ guess: true }),
    );
    assert.deepEqual(rest, []);
    assert.deepEqual(
      [finding.severity, finding.title],
      ["medium", "Browser code may call OpenAI directly (api.openai.com)"],
    );
    assert.match(
      finding.summary,
      /holds a URL for OpenAI \(api\.openai\.com\) next to requests REA could not resolve/,
    );
    assert.match(
      finding.why,
      /did not see this code call OpenAI, only its URL/,
    );
  });

  it("counts a URL old browser code only held as a guess, not as a call", () => {
    // Old browser code held the URL; new browser code calls it.
    const [call] = providers(
      browserApp({ guess: true }),
      browserApp({ call: true }),
    );
    assert.deepEqual(
      [call.severity, call.title],
      ["medium", "Browser code calls OpenAI directly (api.openai.com)"],
    );
    // A URL that is still only held is not a new placement.
    assert.deepEqual(
      providers(browserApp({ guess: true }), browserApp({ guess: true })),
      [],
    );
  });
});

// server.js imports the local client module src/http.js, which imports
// axios, and holds a URL literal it does not pass to it; REA saw no request
// in either.
const importer = (url) =>
  app({
    modules: new Map([
      [
        "src/server.js",
        {
          externalImports: new Set(),
          local: new Set(["src/http.js"]),
          imported: new Map(),
          exports: new Map(),
          reexports: new Map(),
          stars: new Set(),
        },
      ],
    ]),
    imports: [
      fact(
        "axios",
        { specifier: "axios", module: "src/http.js" },
        at("src/http.js", 1),
      ),
    ],
    urlLiterals: [
      fact(
        url,
        { module: "src/server.js", url, value: url, binding: "TARGET" },
        at("src/server.js", 2),
      ),
    ],
  });

describe("guesses around HTTP clients REA does not model", () => {
  it("does not take a URL in a module that only imports a client module as a destination", () => {
    // A link or docs URL in a module that imports the API wrapper is not
    // evidence that the value reaches the client.
    assert.deepEqual(
      evaluate(
        side("v1", importer("https://api.vendor-a.example/v1")),
        side("v2", importer("https://collect.vendor-b.example/v1")),
      ).filter((item) => item.rule === "RW-N01"),
      [],
    );
  });

  it("words a cleartext URL next to an unmodeled client as a possible connection", () => {
    const [finding, ...rest] = evaluate(
      side("v1", client("https://sync.vendor-a.example/v1")),
      side("v2", client("http://sync.vendor-a.example/v1")),
    ).filter((item) => item.rule === "RW-N03");
    assert.deepEqual(rest, []);
    assert.deepEqual(
      [finding.severity, finding.title],
      ["medium", "Possible cleartext connection to sync.vendor-a.example"],
    );
    assert.match(
      finding.summary,
      /holds a URL for sync\.vendor-a\.example that uses http, which Release Watch takes as a possible destination/,
    );
    assert.match(finding.why, /did not see a request to this URL/);
  });

  it("notes a host another component of the old release named, for a new component", () => {
    const named = side(
      "v1",
      app({
        stringLiterals: [
          fact(
            "src/hosts.js#SYNC_HOST",
            {
              module: "src/hosts.js",
              value: "sync.vendor-a.example",
              binding: "SYNC_HOST",
            },
            at("src/hosts.js", 1),
          ),
        ],
      }),
    );
    const absent = side("v1", null, { target: null });
    const [finding] = evaluate(
      absent,
      side(
        "v2",
        app({
          requests: [
            fact(
              "src/sync.js#fetch",
              {
                module: "src/sync.js",
                method: "fetch",
                endpoint: "https://sync.vendor-a.example/push",
                range: range(1, 0, 1, 60),
              },
              at("src/sync.js", 1),
            ),
          ],
        }),
      ),
      { baseline: releaseBaseline([absent, named]) },
    ).filter((item) => item.rule === "RW-N01");
    assert.equal(finding.severity, "high");
    assert.ok(
      finding.unknowns.some((unknown) =>
        /v1's code held the name sync\.vendor-a\.example as a string/.test(
          unknown,
        ),
      ),
      finding.unknowns.join("\n"),
    );
  });
});
