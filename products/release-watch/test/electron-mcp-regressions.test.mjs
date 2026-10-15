// Electron and MCP rule semantics the fixture releases do not exercise:
// windows that move file, fuses REA could not read, executables added next
// to hardened ones, and MCP tools that reach exec through helpers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { app, at, evaluate, fact, range, rules, side } from "./helpers.mjs";

describe("Electron windows and fuses", () => {
  const window = (file, preferences) =>
    fact(
      file,
      { source_path: file, web_preferences: preferences },
      at(file, 4),
    );

  it("grades a window that moved file and enabled Node.js integration", () => {
    const findings = evaluate(
      side("v1", app({ windows: [window("main.js", {})] })),
      side(
        "v2",
        app({
          windows: [
            window("windows/main.js", {
              nodeIntegration: { known: true, value: true },
            }),
          ],
        }),
      ),
    );
    assert.deepEqual(rules(findings), ["RW-E02"]);
    assert.equal(findings[0].severity, "high");
    const [before, after] = findings[0].evidence;
    assert.equal(
      before.basis,
      "heuristic",
      "an omitted option relies on Electron's default",
    );
    assert.equal(before.side, "left");
    assert.equal(after.basis, "observed");
  });

  const runtime = (name, fuses, ambiguous = false) => ({
    name,
    fuses: {
      ambiguous,
      sentinel_count: ambiguous ? 2 : 1,
      fuses,
      implications: [],
      limitations: [],
    },
  });
  const dist = (label, runtimes, candidates = runtimes.length) =>
    side(label, app(), {
      target: { root: `/releases/${label}`, kind: "electron-dist", app: "/x" },
      runtimes,
      runtimeStatus: { candidates, failures: [] },
    });

  it("grades a fuse REA read as enabled, and reports an unreadable one as a coverage gap", () => {
    const hardened = [runtime("acme", { RunAsNode: "disabled" })];
    assert.deepEqual(
      rules(
        evaluate(
          dist("v1", hardened),
          dist("v2", [runtime("acme", { RunAsNode: "enabled" })]),
        ),
      ),
      ["RW-E03"],
    );
    assert.deepEqual(
      rules(
        evaluate(
          dist("v1", hardened),
          dist("v2", [runtime("acme", { RunAsNode: "unknown" })]),
        ),
      ),
      ["RW-C03"],
    );
    const missing = evaluate(dist("v1", hardened), dist("v2", [], 1));
    assert.deepEqual(rules(missing), ["RW-C03"]);
    assert.match(missing[0].evidence[0].claim, /found no fuse wire/);
    assert.match(
      evaluate(dist("v1", hardened), dist("v2", [], 0))[0].evidence[0].claim,
      /no executable at its root/,
    );
  });

  it("grades an unsafe fuse whose old state was not established, and a new unhardened executable", () => {
    const ambiguous = evaluate(
      dist("v1", [runtime("acme", {}, true)]),
      dist("v2", [runtime("acme", { RunAsNode: "enabled" })]),
    );
    assert.deepEqual(
      ambiguous.map((finding) => [finding.rule, finding.severity]),
      [["RW-E03", "medium"]],
    );
    const added = evaluate(
      dist("v1", [runtime("acme", { RunAsNode: "disabled" })]),
      dist("v2", [
        runtime("acme", { RunAsNode: "disabled" }),
        runtime("acme-helper", { RunAsNode: "enabled" }),
      ]),
    );
    assert.deepEqual(rules(added), ["RW-E03"]);
    assert.match(added[0].title, /new executable acme-helper/);
  });
});

describe("MCP servers", () => {
  const server = "src/server.js";
  const tools = "src/tools.js";
  const mcp = (childProcesses) =>
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
      memberCalls: [
        fact(
          `${tools}#read:/registerTool`,
          { module: tools, member: "registerTool", range: range(5, 0, 20, 2) },
          at(tools, 5),
        ),
      ],
      childProcesses,
    });
  const exec = fact(
    `${tools}#exec`,
    {
      module: tools,
      method: "exec",
      command: null,
      range: range(12, 4, 12, 40),
    },
    at(tools, 12),
  );

  it("connects a registration in a module that only receives the server object", () => {
    const findings = evaluate(side("v1", mcp([])), side("v2", mcp([exec])));
    assert.deepEqual(rules(findings), ["RW-M01"]);
  });

  it("does not report a tool that already reached the same exec site", () => {
    assert.deepEqual(
      rules(evaluate(side("v1", mcp([exec])), side("v2", mcp([exec])))),
      [],
    );
  });
});

// One MCP server module with a registerTool call at lines 10-20.
const server = "src/server.js";
const mcpApp = ({ execs, functions = [], reads = [] }) =>
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
    memberCalls: [
      fact(
        `${server}#read:/registerTool`,
        {
          module: server,
          member: "registerTool",
          range: range(10, 0, 20, 2),
        },
        at(server, 10),
      ),
    ],
    childProcesses: execs,
    functions,
    bindingReads: reads,
  });
const exec = (module, line, command = null) =>
  fact(
    `${module}#exec`,
    { module, method: "exec", command, range: range(line, 2, line, 30) },
    at(module, line),
  );

describe("MCP tool reachability", () => {
  it("follows a tool handler into a function defined in the same module", () => {
    const helper = mcpApp({
      execs: [exec(server, 40)],
      functions: [
        {
          id: "fn-run",
          module: server,
          name: "runCommand",
          range: range(38, 0, 42, 1),
        },
      ],
      // REA gives a declaration's binding the declared function as owner.
      reads: [
        fact(
          `${server}#runCommand`,
          {
            module: server,
            name: "runCommand",
            range: range(15, 6, 15, 16),
            binding_range: range(38, 9, 38, 19),
            binding_owner: "fn-run",
          },
          at(server, 15),
        ),
      ],
    });
    const findings = evaluate(
      side("v1", mcpApp({ execs: [] })),
      side("v2", helper),
    );
    assert.deepEqual(rules(findings), ["RW-M01"]);
    assert.match(
      findings[0].evidence[2].claim,
      /reads runCommand, a function in the same module; exec\(\) runs there/,
    );
  });

  it("does not call a tool's exec new when it only moved into a helper module", () => {
    const inline = mcpApp({ execs: [exec(server, 15, "git gc --auto")] });
    const moved = mcpApp({
      execs: [exec("src/shell.js", 3, "git gc --auto")],
      functions: [
        {
          id: "fn-run",
          module: "src/shell.js",
          name: "runCommand",
          range: range(1, 0, 5, 1),
        },
      ],
    });
    moved.modules = new Map([
      [
        server,
        {
          externalImports: new Set(),
          local: new Set(["src/shell.js"]),
          imported: new Map([
            ["runCommand", { module: "src/shell.js", name: "runCommand" }],
          ]),
          exports: new Map(),
          reexports: new Map(),
        },
      ],
    ]);
    moved.bindingReads = [
      fact(
        `${server}#runCommand`,
        {
          module: server,
          name: "runCommand",
          range: range(15, 6, 15, 16),
          binding_range: range(2, 9, 2, 19),
          binding_owner: null,
        },
        at(server, 15),
      ),
    ];
    const findings = evaluate(side("v1", inline), side("v2", moved));
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity]),
      [["RW-P01", "low"]],
    );
  });
});
