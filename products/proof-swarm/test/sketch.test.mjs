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

import { writeFiles } from "../../release-watch/test/cli-run.mjs";

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
    assert.match(zero.positions[0].why, /finds no process-capable file/);
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
