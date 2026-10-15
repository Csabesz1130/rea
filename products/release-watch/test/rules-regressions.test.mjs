// Rule semantics that the fixture releases do not exercise: changed keys,
// counted sites, moved windows, unreadable fuses and partial coverage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { releaseBaseline, verdictFor } from "../src/policy.mjs";
import { app, at, evaluate, fact, range, rules, side } from "./helpers.mjs";

const key = "sk-proj-DEMO-not-a-real-key-000000000000000000";
const literal = (module, binding, value, line = 1) =>
  fact(`${module}#${binding}`, { module, value, binding }, at(module, line));

describe("credential literals", () => {
  it("finds a key assigned to an existing variable and a key inside a longer string", () => {
    const left = app({
      stringLiterals: [literal("src/config.js", "KEY", "placeholder")],
    });
    const right = app({
      stringLiterals: [
        literal("src/config.js", "KEY", key),
        literal(
          "src/client.js",
          "HEADERS",
          `Bearer ${key.replace("DEMO", "DEMO2")} for the API`,
        ),
      ],
    });
    const findings = evaluate(side("v1", left), side("v2", right));
    assert.deepEqual(rules(findings), ["RW-A02", "RW-A02"]);
    assert.ok(!JSON.stringify(findings).includes(key));
  });

  it("does not report a key the old release already shipped", () => {
    const shipped = app({
      stringLiterals: [literal("src/config.js", "KEY", key)],
    });
    assert.deepEqual(
      rules(evaluate(side("v1", shipped), side("v2", shipped))),
      [],
    );
  });
});

describe("counted sites", () => {
  it("reports one process finding with both counts when a module gains an exec site", () => {
    const exec = (line) =>
      fact(
        "src/run.js#exec",
        {
          module: "src/run.js",
          method: "exec",
          command: null,
          range: range(line, 0, line, 9),
        },
        at("src/run.js", line),
      );
    const findings = evaluate(
      side("v1", app({ childProcesses: [exec(3)] })),
      side("v2", app({ childProcesses: [exec(3), exec(9)] })),
    );
    assert.deepEqual(rules(findings), ["RW-P01"]);
    assert.match(findings[0].summary, /2 such sites here, 1 in v1/);
    assert.equal(findings[0].evidence.length, 2);
  });
});

describe("web builds", () => {
  const source = (original) =>
    fact(
      original,
      { original, content_sha256: null },
      at("assets/app.js.map", 1),
    );

  it("reports shipped original sources only when the old build shipped none", () => {
    assert.deepEqual(
      rules(
        evaluate(
          side("v1", app()),
          side("v2", app({ embeddedSources: [source("src/a.ts")] })),
        ),
      ),
      ["RW-W03"],
    );
    assert.deepEqual(
      rules(
        evaluate(
          side("v1", app({ embeddedSources: [source("src/a.ts")] })),
          side(
            "v2",
            app({ embeddedSources: [source("src/a.ts"), source("src/b.ts")] }),
          ),
        ),
      ),
      [],
    );
  });

  it("lists new third-party imports once per component, without built-ins or AI SDKs", () => {
    const imports = (...specifiers) =>
      specifiers.map((specifier) =>
        fact(
          specifier,
          { specifier, module: "src/main.js" },
          at("src/main.js", 1),
        ),
      );
    const findings = evaluate(
      side("v1", app({ imports: imports("react") })),
      side(
        "v2",
        app({
          imports: imports(
            "react",
            "node:fs",
            "path",
            "left-pad",
            "@scope/pkg/sub.js",
            "openai",
          ),
        }),
      ),
    );
    const dependency = findings.find((finding) => finding.rule === "RW-D01");
    assert.match(dependency.title, /\(2\): left-pad, @scope\/pkg/);
    assert.deepEqual(rules(findings), ["RW-A03", "RW-D01"]);
  });
});

describe("network destinations", () => {
  const endpoint = (url, file) =>
    fact(
      url,
      { value: url, mechanism: "call:fetch", candidate: false },
      at(file, 2),
    );

  it("reports a new cleartext channel to a host the old release reached over https", () => {
    const findings = evaluate(
      side(
        "v1",
        app({
          endpoints: [endpoint("https://telemetry.example.net/v1", "a.js")],
        }),
      ),
      side(
        "v2",
        app({
          endpoints: [endpoint("http://telemetry.example.net/v1", "a.js")],
        }),
      ),
    );
    assert.deepEqual(rules(findings), ["RW-N03"]);
  });

  it("says absence is bounded by coverage when the old analysis was partial", () => {
    const [finding] = evaluate(
      side("v1", app()),
      side(
        "v2",
        app({ endpoints: [endpoint("https://collect.example.org/e", "a.js")] }),
      ),
    );
    assert.equal(finding.rule, "RW-N01");
    assert.match(finding.summary, /not seen in v1's analyzed code/);
    assert.ok(
      finding.unknowns.some((unknown) =>
        /coverage of v1 is incomplete/.test(unknown),
      ),
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
    mainHost: "app.example",
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

describe("coverage", () => {
  const bundle = (sha256) =>
    fact("vendor/bundle.js", { sha256 }, at("vendor/bundle.js", 1));
  const truncated = (sha256) => {
    const truncatedApp = app({ assets: [bundle(sha256)] });
    truncatedApp.coverage = {
      ...truncatedApp.coverage,
      semantic_truncated: true,
      semantic_limits: ["semantic_graph_file_node_ceiling 20000"],
      semantic_ceiling_modules: ["vendor/bundle.js"],
    };
    return truncatedApp;
  };

  it("reviews a truncated analysis of unchanged code and blocks one of changed code", () => {
    const same = evaluate(
      side("v1", app({ assets: [bundle("a")] })),
      side("v2", truncated("a")),
    );
    assert.deepEqual(rules(same), ["RW-C01"]);
    assert.match(
      same[0].evidence.map((item) => item.claim).join("\n"),
      /vendor\/bundle\.js/,
    );
    assert.equal(verdictFor(same, "high").decision, "review");
    const changed = evaluate(
      side("v1", app({ assets: [bundle("a")] })),
      side("v2", truncated("b")),
    );
    assert.equal(changed[0].severity, "high");
    assert.match(changed[0].title, /Changed code in v2 was not examined/);
  });

  it("does not report REA's routine partial graph status as missing code", () => {
    const partial = app();
    partial.coverage = { ...partial.coverage, graph: "partial" };
    assert.deepEqual(
      rules(evaluate(side("v1", app()), side("v2", partial))),
      [],
    );
  });

  it("notes a capture present on one side only", () => {
    const capture = {
      name: "web.har",
      mainHost: null,
      limitations: [],
      exchanges: [],
      documents: [],
      cookies: [],
      credentials: [],
      apiGroups: [],
    };
    assert.deepEqual(
      rules(evaluate(side("v1", app()), side("v2", app(), { capture }))),
      ["RW-C02"],
    );
  });
});

describe("verdict", () => {
  it("blocks on a finding even when another component could not be analyzed", () => {
    assert.equal(
      verdictFor([{ severity: "critical" }], "high", { errors: [{}] }).decision,
      "block",
    );
    assert.equal(
      verdictFor([{ severity: "low" }], "high", { errors: [{}] }).decision,
      "error",
    );
  });
});

describe("release-wide baseline", () => {
  const endpoint = (url, file) =>
    fact(
      url,
      { value: url, mechanism: "call:fetch", candidate: false },
      at(file, 2),
    );

  it("does not call a host new when another component of the old release contacted it", () => {
    const partner = "https://api.partner.example/v1";
    const oldApp = side(
      "v1",
      app({ endpoints: [endpoint(partner, "app.js")] }),
    );
    const newWorker = side(
      "v2",
      app({ endpoints: [endpoint(partner, "worker.js")] }),
    );
    const absent = { ...side("absent", null), target: null };
    assert.deepEqual(rules(evaluate(absent, newWorker)), ["RW-C02", "RW-N01"]);
    assert.deepEqual(
      rules(
        evaluate(absent, newWorker, { baseline: releaseBaseline([oldApp]) }),
      ),
      ["RW-C02"],
    );
  });
});

describe("moved process execution", () => {
  const exec = (module) =>
    fact(
      `${module}#exec`,
      { module, method: "exec", command: null, range: range(3, 0, 3, 9) },
      at(module, 3),
    );

  it("reports an exec site that moved to another module low, with its old location", () => {
    const findings = evaluate(
      side("v1", app({ childProcesses: [exec("dist/index.js")] })),
      side("v2", app({ childProcesses: [exec("dist/tools/run.js")] })),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity]),
      [["RW-P01", "low"]],
    );
    assert.equal(findings[0].evidence.at(-1).side, "left");
  });
});

describe("unpaired bundles", () => {
  it("says when a bundle could not be paired because several share its name", () => {
    const bundle = "assets/index-Gg77Hh88.js";
    const exec = fact(
      `${bundle}#exec`,
      {
        module: bundle,
        method: "exec",
        command: null,
        range: range(1, 0, 1, 9),
      },
      at(bundle, 1),
    );
    const [finding] = evaluate(
      side("v1", app()),
      side("v2", app({ childProcesses: [exec] })),
      {
        ambiguous: new Set([bundle]),
      },
    );
    assert.ok(
      finding.unknowns.some((unknown) =>
        /could not pair it with its old version/.test(unknown),
      ),
    );
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
      mainHost: "app.example",
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

describe("process and request sites", () => {
  const exec = (module, command) =>
    fact(
      `${module}#exec`,
      { module, method: "exec", command, range: range(3, 0, 3, 9) },
      at(module, 3),
    );

  it("keeps an exec with an unresolved command high when the removed one ran a fixed command", () => {
    const findings = evaluate(
      side(
        "v1",
        app({ childProcesses: [exec("version.js", "git --version")] }),
      ),
      side("v2", app({ childProcesses: [exec("remote.js", null)] })),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity]),
      [["RW-P01", "high"]],
    );
  });

  it("reports a command that became dynamic with the same number of sites", () => {
    const findings = evaluate(
      side("v1", app({ childProcesses: [exec("run.js", "uname -a")] })),
      side("v2", app({ childProcesses: [exec("run.js", null)] })),
    );
    assert.deepEqual(rules(findings), ["RW-P01"]);
    assert.match(findings[0].title, /Process execution changed/);
  });

  it("reports one finding per key when a module gains a second request site", () => {
    const fetchAt = (line) =>
      fact(
        "a.js#fetch",
        {
          module: "a.js",
          method: "fetch",
          endpoint: null,
          range: range(line, 0, line, 9),
        },
        at("a.js", line),
      );
    const findings = evaluate(
      side("v1", app({ requests: [fetchAt(2)] })),
      side("v2", app({ requests: [fetchAt(2), fetchAt(9)] })),
    );
    assert.deepEqual(rules(findings), ["RW-N02"]);
  });
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
      mainHost: "app.example",
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
