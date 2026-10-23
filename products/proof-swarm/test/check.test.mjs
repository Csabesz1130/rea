// The check and the collection through the public CLI, on packages written
// for each case: a claim passes only when what it cites is in the package's
// shipped text, a "no" only when it accounts for everything the scan finds,
// and an answer only when a consistent review upholds a passing claim.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { writeFiles } from "../../release-watch/test/cli-run.mjs";

const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "proof-swarm.mjs",
);
const root = mkdtempSync(path.join(tmpdir(), "proof-swarm-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
const write = (files) =>
  writeFiles(path.join(root, `package-${(count += 1)}`), {
    "package.json": JSON.stringify({ name: "server", type: "module" }),
    ...files,
  });

const run = (args) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
  return { result, output: result.stdout ? JSON.parse(result.stdout) : null };
};

const check = (dir, claim) => {
  const file = path.join(root, `claim-${(count += 1)}.json`);
  writeFileSync(file, JSON.stringify(claim));
  return run(["check", file, "--package", dir]);
};

// A tool whose handler calls a helper that runs a command through exec.
const runner = () =>
  write({
    "dist/tools.js": [
      'import { runCommand } from "./run.js";',
      "export const register = (server) => {",
      '  server.registerTool("deploy", { description: "Deploy" }, async () => {',
      '    const result = await runCommand("deploy --prod");',
      '    return { content: [{ type: "text", text: result }] };',
      "  });",
      "};",
    ].join("\n"),
    "dist/run.js": [
      'import { exec } from "node:child_process";',
      "export const runCommand = (command) =>",
      "  new Promise((resolve) => {",
      "    exec(command, (error, stdout) => resolve(stdout));",
      "  });",
    ].join("\n"),
  });

const yes = (hops) => ({
  verdict: "yes",
  shell: "yes",
  paths: [{ tool: "deploy", hops }],
  hint_sequence: ["the deploy tool runs a helper", "the helper calls exec"],
});

const HOPS = [
  {
    file: "dist/tools.js",
    line: 3,
    text: 'server.registerTool("deploy"',
    role: "registration",
  },
  {
    file: "dist/tools.js",
    line: 4,
    text: 'await runCommand("deploy --prod")',
    role: "call",
    calls: "runCommand",
  },
  {
    file: "dist/run.js",
    line: 2,
    text: "export const runCommand = (command) =>",
    role: "definition",
    defines: "runCommand",
  },
  {
    file: "dist/run.js",
    line: 4,
    text: "exec(command, (error, stdout)",
    role: "process",
  },
];

describe("check: a yes path", () => {
  const dir = runner();

  it("passes a path that is in the shipped code", () => {
    const { result, output } = check(dir, yes(HOPS));
    assert.equal(result.status, 0, result.stdout);
    assert.equal(output.status, "pass");
  });

  it("fails a shifted line, a missing definition and invented code", () => {
    const shifted = HOPS.map((hop, at) =>
      at === 1 ? { ...hop, line: 5 } : hop,
    );
    const undefinedCall = HOPS.filter((hop) => hop.role !== "definition");
    const invented = HOPS.map((hop, at) =>
      at === 3 ? { ...hop, text: 'spawn("bash", ["-c", command])' } : hop,
    );
    for (const [hops, expected] of [
      [shifted, /dist\/tools\.js:5 does not contain/],
      [undefinedCall, /no later hop defines runCommand/],
      [invented, /dist\/run\.js:4 does not contain/],
    ]) {
      const { result, output } = check(dir, yes(hops));
      assert.equal(result.status, 1);
      assert.match(output.errors.join("\n"), expected);
    }
  });

  it("fails a cited test file and a path outside the package", () => {
    for (const [file, expected] of [
      ["dist/run.test.js", /not a running file/],
      ["../outside.js", /not a path inside the package/],
    ]) {
      const hops = HOPS.map((hop, at) => (at === 3 ? { ...hop, file } : hop));
      const { output } = check(dir, yes(hops));
      assert.match(output.errors.join("\n"), expected);
    }
  });

  it("fails a shell yes when the process call passes no shell", () => {
    const spawned = write({
      "index.js": [
        'import { spawn } from "node:child_process";',
        'server.registerTool("run", {}, async () => spawn("git", ["status"]));',
      ].join("\n"),
    });
    const claim = yes([
      {
        file: "index.js",
        line: 2,
        text: 'server.registerTool("run"',
        role: "registration",
      },
      {
        file: "index.js",
        line: 2,
        text: 'spawn("git", ["status"])',
        role: "process",
      },
    ]);
    assert.match(check(spawned, claim).output.errors.join("\n"), /shell yes/);
    assert.equal(
      check(spawned, { ...claim, shell: "no" }).output.status,
      "pass",
    );
  });

  it("does not count shell: false as a shell", () => {
    // A reviewer in the first swarm run found this hole in the check.
    const launcher = write({
      "index.js": [
        'import { spawn } from "node:child_process";',
        'server.registerTool("run", {}, async ({ file }) =>',
        '  spawn("ghidra", [file], { shell: false }));',
      ].join("\n"),
    });
    const claim = yes([
      {
        file: "index.js",
        line: 2,
        text: 'server.registerTool("run"',
        role: "registration",
      },
      {
        file: "index.js",
        line: 3,
        text: 'spawn("ghidra", [file]',
        role: "process",
      },
    ]);
    assert.match(check(launcher, claim).output.errors.join("\n"), /shell yes/);
  });
});

describe("check: a no", () => {
  it("fails a no that leaves the process call out", () => {
    const { output } = check(runner(), {
      verdict: "no",
      shell: "no",
      process_sites: [],
      hint_sequence: ["no tool runs commands"],
    });
    assert.equal(output.status, "fail");
    assert.match(
      output.errors.join("\n"),
      /unaccounted candidate process call at dist\/run\.js:4/,
    );
    assert.match(
      output.errors.join("\n"),
      /unaccounted process-capable file dist\/run\.js/,
    );
  });

  it("finds a process function handed to a file that never loads child_process", () => {
    // The case of a gateway that passes spawn on: only the receiving file
    // calls it.
    const dir = write({
      "dist/gateway.js": [
        'import { spawn } from "child_process";',
        "startServer(spawn, args);",
      ].join("\n"),
      "dist/child.js":
        "export const startServer = (spawn, args) => spawn(args[0], args.slice(1));",
    });
    const { output } = check(dir, {
      verdict: "no",
      shell: "no",
      process_sites: [
        {
          file: "dist/gateway.js",
          line: 1,
          text: 'import { spawn } from "child_process"',
          why: "the gateway starts its child at startup, not from a tool",
        },
      ],
      hint_sequence: ["the gateway imports spawn"],
    });
    assert.match(output.errors.join("\n"), /dist\/child\.js:1/);
    assert.match(output.errors.join("\n"), /dist\/gateway\.js:2/);
  });

  it("passes a no that accounts for every site, and asks why runtime code cannot reach one", () => {
    const dir = write({
      "dist/cli.js": [
        'import { execFileSync } from "node:child_process";',
        'export const version = () => execFileSync("git", ["--version"]);',
      ].join("\n"),
      "dist/server.js":
        'server.registerTool("echo", {}, async ({ text }) => text);',
    });
    const claim = {
      verdict: "no",
      shell: "no",
      process_sites: [
        {
          file: "dist/cli.js",
          line: 2,
          text: 'execFileSync("git", ["--version"])',
          why: "only the CLI version command calls it; the echo tool returns its input",
        },
      ],
      hint_sequence: ["the only process call is in the CLI"],
    };
    assert.equal(check(dir, claim).output.status, "pass");
    writeFileSync(
      path.join(dir, "dist", "plugins.js"),
      "export const load = (name) => import(name);\n",
    );
    assert.match(check(dir, claim).output.errors.join("\n"), /residual/);
    assert.equal(
      check(dir, {
        ...claim,
        residual: "plugins.js loads modules by name, but no tool calls load",
      }).output.status,
      "pass",
    );
  });
});

describe("check: undetermined", () => {
  it("needs a residual that says what blocks a decision", () => {
    const dir = runner();
    const claim = {
      verdict: "undetermined",
      shell: "undetermined",
      hint_sequence: ["the bundle is minified"],
    };
    assert.match(check(dir, claim).output.errors.join("\n"), /residual/);
    assert.equal(
      check(dir, {
        ...claim,
        residual: "the handler table is built at runtime from a config file",
      }).output.status,
      "pass",
    );
  });
});

describe("scan", () => {
  it("lists process-capable files, candidate calls and runtime code", () => {
    const { result, output } = run(["scan", runner()]);
    assert.equal(result.status, 0);
    assert.deepEqual(
      output.capable.map((entry) => entry.file),
      ["dist/run.js"],
    );
    assert.deepEqual(
      output.candidates.map(({ file, line }) => `${file}:${line}`),
      ["dist/run.js:4"],
    );
  });

  it("lists process calls as compilers and bundlers emit them", () => {
    // TypeScript calls an imported function through (0, binding.name)(…),
    // and bundlers rename the binding. A solver in round 2 found the scan
    // missed both.
    const dir = write({
      "dist/tsc.js": [
        'const child_process_1 = require("child_process");',
        'const pull = () => (0, child_process_1.spawnSync)("git", ["pull"]);',
      ].join("\n"),
      "dist/bundle.js": [
        'var import_child_process = require("child_process");',
        "var run = (command) => import_child_process.exec(command);",
        "var words = (text) => /\\w+/.exec(text);",
      ].join("\n"),
    });
    assert.deepEqual(
      run(["scan", dir]).output.candidates.map(
        ({ file, line }) => `${file}:${line}`,
      ),
      ["dist/bundle.js:2", "dist/tsc.js:2"],
    );
    const claim = yes([
      {
        file: "dist/bundle.js",
        line: 2,
        text: "import_child_process.exec(command)",
        role: "registration",
      },
      {
        file: "dist/bundle.js",
        line: 2,
        text: "import_child_process.exec(command)",
        role: "process",
      },
    ]);
    // The registration is not real, so the path fails, but not on the
    // shell: exec on a renamed child_process binding runs a shell.
    assert.doesNotMatch(
      check(dir, claim).output.errors.join("\n"),
      /shell yes/,
    );
  });

  it("lists a file that loads the MCP SDK's stdio client transport", () => {
    // It spawns the server it connects to. A reviewer in the first swarm
    // run found a "no" that left it out.
    const dir = write({
      "dist/client.js": [
        'import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";',
        "export const transport = (command) => new StdioClientTransport({ command });",
      ].join("\n"),
      "dist/server.js":
        'import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";',
    });
    assert.deepEqual(run(["scan", dir]).output.capable, [
      {
        file: "dist/client.js",
        imports: [{ line: 1, specifier: "@modelcontextprotocol/client/stdio" }],
      },
    ]);
  });
});

describe("collect", () => {
  // One run over four packages, each with its own fate.
  const dir = runner();
  const claims = mkdtempSync(path.join(root, "claims-"));
  const packages = ["upheld", "unnamed", "invented", "missing", "open"].map(
    (slug) => ({ name: slug, version: "1.0.0", dir, slug, reasons: [] }),
  );
  const save = (slug, claim) =>
    writeFileSync(path.join(claims, `${slug}.json`), JSON.stringify(claim));
  save("upheld", yes(HOPS));
  save("unnamed", yes(HOPS));
  save(
    "invented",
    yes(HOPS.map((hop, at) => (at === 3 ? { ...hop, line: 3 } : hop))),
  );
  save("open", {
    verdict: "undetermined",
    shell: "undetermined",
    residual: "the handler table is built at runtime from a config file",
    hint_sequence: ["the bundle is minified"],
  });
  const review = (name, verdict, failures) => ({
    name,
    verdict,
    failures,
    reason: "read the handler",
    conditions: "none",
  });
  const argsFile = path.join(root, "args.json");
  const resultFile = path.join(root, "result.json");
  writeFileSync(
    argsFile,
    JSON.stringify({ claims, batches: [{ id: 1, packages }] }),
  );
  writeFileSync(
    resultFile,
    JSON.stringify({
      results: [
        {
          batch: 1,
          // The solver's own report is not trusted: it says every check passed.
          solve: {
            packages: packages.map(({ name }) => ({
              name,
              check_status: "pass",
            })),
          },
          review: {
            reviews: [
              review("upheld", "upheld", []),
              review("unnamed", "refuted", []),
              review("invented", "upheld", []),
            ],
          },
        },
      ],
    }),
  );

  it("accepts only a passing claim that a consistent review upholds", () => {
    const { result, output } = run(["collect", argsFile, resultFile]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      Object.fromEntries(
        output.records.map((record) => [record.name, record.outcome]),
      ),
      {
        upheld: "reviewed yes",
        unnamed: "review inconsistent",
        invented: "failed the check",
        missing: "no claim",
        open: "undetermined",
      },
    );
    assert.equal(output.outcomes["reviewed yes"], 1);
    assert.match(
      output.records
        .find((record) => record.name === "invented")
        .check.errors.join("\n"),
      /dist\/run\.js:3 does not contain/,
    );
  });
});
