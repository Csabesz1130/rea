// Runs the public CLI on releases that ship native files, each compiled
// here from a few lines of C: a library whose content changed, a new
// executable, a library that only moved, and files that merely look
// native. Needs REA built and a C compiler.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { releases, run, skip as reaMissing } from "./cli-run.mjs";

const compiler = spawnSync("cc", ["--version"], { encoding: "utf8" });
const skip =
  reaMissing || (compiler.status === 0 ? false : "no C compiler (cc) found");

const written = releases();
const scratch = mkdtempSync(path.join(tmpdir(), "release-watch-native-"));
after(() => {
  written.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

let built = 0;
// Compiles `source` to a shared library or an executable and returns its path.
const compile = (source, { shared = false } = {}) => {
  const base = path.join(scratch, `native-${(built += 1)}`);
  writeFileSync(`${base}.c`, source);
  const result = spawnSync(
    "cc",
    [...(shared ? ["-shared", "-fPIC"] : []), "-o", base, `${base}.c`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return base;
};

const INDEX = { "index.js": "export const version = 1;\n" };
const PACKAGE = { type: "module", main: "index.js" };

// A release with `natives` (path in the release → compiled file) beside
// its script, and `extra` text files.
const release = (version, natives, extra = {}) => {
  const dir = written.write(version, { ...INDEX, ...extra }, PACKAGE);
  for (const [file, from] of Object.entries(natives)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    copyFileSync(from, path.join(dir, file));
  }
  return dir;
};

const compare = (before, after) => {
  const result = run(before, after);
  written.keep(result.out);
  return result;
};

const rules = (report) => report.findings.map((finding) => finding.rule);

describe("compare: native files a release ships", { skip }, () => {
  it("notes a library whose content changed as code that was not examined", () => {
    const { result, report } = compare(
      release("1.0.0", {
        "build/addon.node": compile("int answer(void) { return 1; }", {
          shared: true,
        }),
      }),
      release("1.1.0", {
        "build/addon.node": compile("int answer(void) { return 2; }", {
          shared: true,
        }),
      }),
    );
    // Changed code nobody examined blocks, as RW-C01 does.
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(rules(report), ["RW-C07"]);
    const [finding] = report.findings;
    assert.equal(
      finding.title,
      "Native code changed in v1.1.0 and was not examined",
    );
    assert.match(
      finding.evidence[0].claim,
      /^build\/addon\.node: elf \w+, sha256 [0-9a-f]{64} before, [0-9a-f]{64} now$/,
    );
    const [native] = report.components[0].right.natives;
    assert.equal(native.relative, "build/addon.node");
    assert.equal(native.format, "elf");
    assert.match(native.sha256, /^[0-9a-f]{64}$/);
  });

  it("reports an executable the old release did not ship as new native code", () => {
    const addon = compile("int answer(void) { return 1; }", { shared: true });
    const { report } = compare(
      release("1.0.0", { "build/addon.node": addon }),
      release("1.1.0", {
        "build/addon.node": addon,
        "bin/sync": compile("int main(void) { return 0; }"),
      }),
    );
    assert.deepEqual(rules(report), ["RW-B01"]);
    assert.equal(report.findings[0].severity, "high");
    assert.equal(report.findings[0].title, "New native code: bin/sync");
    assert.match(report.findings[0].summary, /did not ship under any path/);
  });

  it("finds nothing when a library only moves, or a file only looks native", () => {
    const addon = compile("int answer(void) { return 3; }", { shared: true });
    const { report } = compare(
      release("1.0.0", { "build/addon.node": addon }),
      release(
        "1.1.0",
        { "prebuilds/linux-x64/addon.node": addon },
        {
          // A name and a first line are not native code; nor is a Java
          // class file, which starts like a fat Mach-O.
          "build/notes.node": "ELF is a file format.\n",
          "lib/Main.class": Buffer.from([
            0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34, 0, 0x10, 0x0a, 0, 3,
          ]),
        },
      ),
    );
    assert.deepEqual(report.findings, []);
    assert.deepEqual(
      report.components[0].right.natives.map((native) => native.relative),
      ["prebuilds/linux-x64/addon.node"],
    );
  });

  it("compares a directory that holds only native files, without an error", () => {
    const directory = (name, natives) => {
      const dir = mkdtempSync(path.join(scratch, `${name}-`));
      for (const [file, from] of Object.entries(natives)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        copyFileSync(from, path.join(dir, file));
      }
      return dir;
    };
    const { result, report } = compare(
      directory("old", { "bin/tool": compile("int main(void) { return 0; }") }),
      directory("new", {
        "bin/tool": compile("int main(void) { return 1; }"),
        "lib/libextra.so": compile("int extra(void) { return 1; }", {
          shared: true,
        }),
      }),
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal(report.verdict.errors, 0);
    assert.deepEqual(rules(report).sort(), ["RW-B01", "RW-C07"]);
    assert.equal(report.components[0].right.natives.length, 2);
  });
});
