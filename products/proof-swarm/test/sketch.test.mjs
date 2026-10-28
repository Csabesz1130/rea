// The sketch, plan and collect through the public CLI, on packages written
// for each case: level 0 settles a package only when nothing that can run
// starts a process, and every way code outside the entry points' imports
// could still run keeps it open.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { skip, writeFiles } from "../../release-watch/test/cli-run.mjs";

const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "proof-swarm.mjs",
);
const root = mkdtempSync(path.join(tmpdir(), "proof-swarm-sketch-"));
after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
const write = (manifest, files) =>
  writeFiles(path.join(root, `package-${(count += 1)}`), {
    "package.json": JSON.stringify({
      name: "server",
      type: "module",
      ...manifest,
    }),
    ...files,
  });

const run = (args) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
  return { result, output: result.stdout ? JSON.parse(result.stdout) : null };
};
const levels = (dir) => run(["sketch", dir]).output.levels;
const head = (dir) => levels(dir)[0].positions[0];

// A server whose tools only fetch, and a release script that runs a shell
// command but that no entry point loads.
const server = (extra = {}) =>
  write(
    {
      bin: "dist/server.js",
      main: "dist/index.js",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./tools/*": "./dist/tools/*.js",
      },
    },
    {
      "dist/server.js": [
        'import { list } from "./tools/list.js";',
        'server.registerTool("list", {}, list);',
        ...(extra.server ?? []),
      ].join("\n"),
      "dist/index.js": 'export * from "./lib";',
      "dist/lib/index.js": "export const version = 1;",
      "dist/index.d.ts": "export declare const version: number;",
      "dist/tools/list.js":
        'export const list = async () => fetch("https://api.example.com/items");',
      "scripts/release.js": [
        'import { execSync } from "node:child_process";',
        'execSync("npm publish");',
      ].join("\n"),
      ...extra.files,
    },
  );

describe("sketch: level 0", () => {
  it("settles a package in which nothing can start a process", () => {
    const dir = write(
      { bin: "index.js" },
      {
        "index.js":
          'server.registerTool("get", {}, async () => fetch("https://api.example.com"));',
      },
    );
    const [zero, ...rest] = levels(dir);
    assert.equal(zero.positions[0].verdict, "no");
    assert.match(
      zero.positions[0].why,
      /nothing in the shipped files can start a process/,
    );
    assert.deepEqual(
      rest.map((level) => level.positions.length),
      [0, 0, 0],
    );
  });

  it("settles a package whose process code no entry point loads", () => {
    const top = head(server());
    assert.equal(top.verdict, "no");
    assert.match(top.why, /outside what the entry points load/);
    // bin and main without "./", the exports pattern and the directory
    // import all count; the declaration file does not.
    assert.equal(top.entry_points, 3);
    assert.equal(top.reached, 4);
  });

  it("keeps it open when code loaded at runtime could load that code", () => {
    const dir = server({
      server: ["const plugin = await import(process.env.PLUGIN);"],
    });
    const [zero, one, two, three] = levels(dir);
    assert.equal(zero.positions[0].verdict, "open");
    assert.deepEqual(one.positions, [
      "dist/server.js",
      "dist/index.js",
      "dist/tools/list.js",
    ]);
    assert.deepEqual(
      two.positions.map(({ file, reached }) => `${file} ${reached}`),
      ["dist/server.js true", "scripts/release.js false"],
    );
    assert.deepEqual(
      three.positions.map(({ file, line, kind }) => `${file}:${line} ${kind}`),
      [
        "dist/server.js:3 code loaded or evaluated at runtime",
        "dist/server.js:2 tool registration",
      ],
    );
  });

  it("counts a require of a computed template path as code loaded at runtime", () => {
    // A solver in round 3 found the scan read it as a literal specifier.
    const dir = server({
      server: ["const manifest = require(`${process.env.DIR}/package.json`);"],
    });
    assert.equal(head(dir).verdict, "open");
    assert.deepEqual(
      run(["scan", dir]).output.runtimeCode.map(
        ({ file, line }) => `${file}:${line}`,
      ),
      ["dist/server.js:3"],
    );
  });

  it("lists every way code outside the closure could still run", () => {
    const dir = server({
      server: [
        'import "./missing.js";',
        'const addon = createRequire(import.meta.url)("../build/addon.node");',
        'const native = require("../build/addon.node");',
        'const worker = new Worker("./worker.js");',
        'import { helper } from "server/helpers";',
        'import "./worker.test.js";',
      ],
      files: {
        "build/addon.node": "native",
        "dist/worker.test.js": 'import "./helpers.js";',
      },
    });
    const three = levels(dir)[3].positions.filter(
      ({ kind }) => kind !== "tool registration",
    );
    assert.deepEqual(
      three.map(({ kind }) => kind),
      [
        "unresolved import",
        "unresolved import of the package itself",
        "native addon",
        "loads a script the scan leaves out",
        "code loaded or evaluated at runtime",
        "worker started from a path",
      ],
    );
  });
});

describe("sketch: entry points", () => {
  it("reads every running file when the package names no entry point", () => {
    const dir = write(
      {},
      {
        "lib/tools.js": 'server.registerTool("list", {}, async () => []);',
        "lib/shell.js": 'require("child_process").execSync("make");',
      },
    );
    const top = head(dir);
    assert.equal(top.entry_points, 0);
    assert.equal(top.reached, 2);
    assert.equal(top.verdict, "open");
  });
});

// Text that is no call: a comment, a string, a regex and a method
// definition, each matching a process call or eval.
const FALSE_POSITIVES = [
  '// We never call spawn("x") or eval(code) here.',
  'const help = "run exec(cmd) yourself";',
  "const pattern = /exec(?:Sync)?\\(/;",
  "export const tools = { spawn(options) { return options; } };",
  'server.registerTool("help", {}, async () => help);',
];

describe("sketch with REA's facts", () => {
  it("rules out text that REA's parse finds no call in", { skip }, () => {
    const dir = write(
      { bin: "index.js" },
      { "index.js": FALSE_POSITIVES.join("\n") },
    );
    assert.equal(head(dir).verdict, "open");
    const top = run(["sketch", dir, "--rea"]).output.levels[0].positions[0];
    assert.equal(top.verdict, "no");
    assert.equal(top.basis, "scan and REA");
    assert.deepEqual(top.rea.files, ["index.js"]);
    assert.deepEqual(
      top.rea.discharged.map(({ line }) => line),
      [1, 2, 3, 4],
    );
  });

  it(
    "keeps real calls, other line breaks and recovered parses open",
    { skip },
    () => {
      const dir = write(
        { bin: "index.js" },
        {
          "index.js": [
            'import "./a.js";',
            'import "./b.js";',
            'import "./c.js";',
          ].join("\n"),
          // REA counts U+2028 as a line break and the scan does not; the eval
          // is real all the same.
          "a.js":
            'const separated = "one\u2028two";\nexport const run = (code) => eval(code);',
          // REA's parser recovers from the redeclaration and still reports
          // the eval after it.
          "b.js":
            "let x = 1;\nlet x = 2;\nexport const run = (code) => eval(code);",
          "c.js": 'export const note = "spawn(a) is not called";',
        },
      );
      const { levels } = run(["sketch", dir, "--rea"]).output;
      const [top] = levels[0].positions;
      assert.equal(top.verdict, "open");
      assert.deepEqual(
        top.rea.discharged.map(({ file, line }) => `${file}:${line}`),
        ["c.js:1"],
      );
      assert.deepEqual(
        levels[3].positions.map(
          ({ file, line, kind }) => `${file}:${line} ${kind}`,
        ),
        [
          "a.js:2 code loaded or evaluated at runtime",
          "b.js:3 code loaded or evaluated at runtime",
        ],
      );
    },
  );

  it("leaves forms REA does not report where they match to the scan", () => {
    const dir = write(
      { bin: "index.js" },
      { "index.js": "export const value = globalThis.eval(source);" },
    );
    const top = run(["sketch", dir, "--rea"]).output.levels[0].positions[0];
    assert.equal(top.verdict, "open");
    assert.equal(top.basis, "scan");
    assert.equal(top.rea, undefined);
  });
});

describe("plan and collect", () => {
  it("settles what level 0 settles and gives the rest their sketch", () => {
    const quiet = write(
      { bin: "index.js" },
      { "index.js": 'server.registerTool("ping", {}, async () => "pong");' },
    );
    const open = server({ server: ["await import(process.env.PLUGIN);"] });
    const claims = mkdtempSync(path.join(root, "claims-"));
    const args = path.join(root, "args.json");
    writeFileSync(
      args,
      JSON.stringify({
        claims,
        batches: [
          {
            id: 1,
            packages: [
              {
                name: "quiet",
                version: "1.0.0",
                dir: quiet,
                slug: "quiet",
                reasons: [],
              },
              {
                name: "open",
                version: "1.0.0",
                dir: open,
                slug: "open",
                reasons: [],
              },
            ],
          },
        ],
      }),
    );
    const planned = run(["plan", args]).output;
    assert.deepEqual(
      planned.settled.map((item) => `${item.name} ${item.sketch.verdict}`),
      ["quiet no"],
    );
    assert.deepEqual(
      planned.batches[0].packages[0].sketch.map((level) => level.level),
      [0, 1, 2],
    );
    const plannedFile = path.join(root, "planned.json");
    const resultFile = path.join(root, "empty-result.json");
    writeFileSync(plannedFile, JSON.stringify(planned));
    writeFileSync(resultFile, JSON.stringify({ results: [] }));
    const { outcomes } = run(["collect", plannedFile, resultFile]).output;
    assert.equal(outcomes["settled by the scan"], 1);
    assert.equal(outcomes["no claim"], 1);
  });

  it(
    "settles with REA's facts and collects on the same basis",
    { skip },
    () => {
      const dir = write(
        { bin: "index.js" },
        { "index.js": FALSE_POSITIVES.join("\n") },
      );
      const args = path.join(root, "rea-args.json");
      const item = {
        name: "help",
        version: "1.0.0",
        dir,
        slug: "help",
        reasons: [],
      };
      writeFileSync(
        args,
        JSON.stringify({
          claims: mkdtempSync(path.join(root, "claims-")),
          batches: [{ id: 1, packages: [item] }],
        }),
      );
      const planned = run(["plan", args, "--rea"]).output;
      assert.deepEqual(planned.batches, []);
      assert.equal(planned.settled[0].sketch.basis, "scan and REA");
      const plannedFile = path.join(root, "rea-planned.json");
      const resultFile = path.join(root, "rea-result.json");
      writeFileSync(plannedFile, JSON.stringify(planned));
      writeFileSync(resultFile, JSON.stringify({ results: [] }));
      const { records } = run(["collect", plannedFile, resultFile]).output;
      assert.equal(records[0].outcome, "settled by the scan");
      assert.equal(records[0].sketch.basis, "scan and REA");
    },
  );
});

describe("scan: loaders bundlers and createRequire leave", () => {
  it("counts every name that loads child_process and every passed-on createRequire", () => {
    const dir = write(
      { bin: "index.mjs" },
      {
        "index.mjs": [
          'import { createRequire as makeRequire } from "node:module";',
          'const { spawn } = __require("child_process");',
          "const load = /* @__PURE__ */ makeRequire(import.meta.url);",
          'const cp = load("node:child_process");',
          'const viaModule = Module._load("child_process");',
          'const optional = process.getBuiltinModule?.("node:child_process");',
          'const direct = makeRequire(import.meta.url)("child_process");',
          'plugins.push(makeRequire(new URL("./", import.meta.url)));',
          'spawn?.("ls");',
          // Formatted over lines, wrapped as rolldown emits it, and called
          // on the next line.
          "const split = makeRequire(",
          "  import.meta.url,",
          ");",
          'split("child_process");',
          "var __rolled = /* #__PURE__ */ (() => makeRequire(import.meta.url))();",
          "const later = makeRequire(import.meta.url) // the next line calls it",
          '  ("child_process");',
        ].join("\n"),
      },
    );
    const { output } = run(["scan", dir]);
    assert.deepEqual(
      output.capable[0].imports.map(({ line }) => line),
      [2, 4, 5, 6, 13],
    );
    assert.deepEqual(
      output.runtimeCode.map(({ line, forms }) => `${line} ${forms[0].form}`),
      [
        "7 createRequire result passed on",
        "8 createRequire result passed on",
        "15 createRequire result passed on",
      ],
    );
    assert.deepEqual(
      output.candidates.map(({ line }) => line),
      [9],
    );
  });
});

describe("scan: child_process without an import", () => {
  it("counts getBuiltinModule and Node's spawn bindings", () => {
    const dir = write(
      { bin: "index.js" },
      {
        "index.js": [
          'const cp = process.getBuiltinModule("node:child_process");',
          'const raw = process.binding("spawn_sync");',
          'const tty = process.binding("tty_wrap");',
        ].join("\n"),
      },
    );
    const { output } = run(["scan", dir]);
    assert.deepEqual(
      output.capable.map(
        ({ file, imports }) => `${file} ${imports[0].specifier}`,
      ),
      ["index.js node:child_process"],
    );
    assert.deepEqual(
      output.candidates.map(({ line }) => line),
      [2],
    );
  });
});
