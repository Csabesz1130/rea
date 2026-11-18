// The detector against files each test writes: a minified bundle and a
// readable source, a native header with and without a packer's markers, and
// archive magics. The inputs are small and written here, so the thresholds
// and markers are checked without shipping a large real binary; the README
// records what the detector reported on real bundles and binaries.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { fingerprint } from "../src/fingerprint.mjs";

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "obfuscation-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (name, contents) => {
  const file = path.join(dir, name);
  writeFileSync(file, contents);
  return file;
};

// A 64-byte header buffer that starts with `magic` and holds `markers` far
// enough in to stand for a packed binary's section names.
const nativeHeader = (magic, markers = []) => {
  const buffer = Buffer.alloc(4096, 0x41);
  magic.copy(buffer, 0);
  let offset = 256;
  for (const marker of markers) {
    buffer.write(marker, offset, "latin1");
    offset += marker.length + 8;
  }
  return buffer;
};

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

describe("javascript", () => {
  it("names the bundler and calls a long-lined file minified", () => {
    const line = `var ${"a".repeat(2)}=${"b".repeat(6000)};`;
    const result = fingerprint(
      write("bundle.js", `__esm({});\n${line}\n__toCommonJS({});\n`),
    );
    assert.equal(result.kind, "javascript");
    assert.deepEqual(result.bundlers, ["esbuild"]);
    assert.equal(result.minified.likely, true);
    assert.ok(result.measured.max_line >= 6000);
  });

  it("leaves readable source unflagged", () => {
    const source = Array.from(
      { length: 40 },
      (_, index) => `export const value${index} = ${index}; // a comment here`,
    ).join("\n");
    const result = fingerprint(write("source.js", `${source}\n`));
    assert.equal(result.kind, "javascript");
    assert.deepEqual(result.bundlers, []);
    assert.equal(result.minified.likely, false);
    assert.deepEqual(result.minified.reasons, []);
  });
});

describe("native", () => {
  it("reports a UPX-packed binary's markers and format", () => {
    const result = fingerprint(
      write("packed", nativeHeader(ELF, ["UPX!", "UPX0", "UPX1"])),
    );
    assert.equal(result.kind, "native");
    assert.equal(result.format, "elf");
    assert.deepEqual(result.packer.detected, ["UPX"]);
    assert.ok(result.packer.markers.length >= 1);
  });

  it("reports no packer for a plain header, with entropy as a hint", () => {
    const result = fingerprint(write("plain.exe", nativeHeader(PE)));
    assert.equal(result.format, "pe");
    assert.deepEqual(result.packer.detected, []);
    assert.equal(typeof result.entropy.bits_per_byte, "number");
  });
});

describe("archives", () => {
  it("names a zip, an APK and an asar without opening them", () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(32),
    ]);
    assert.equal(fingerprint(write("bundle.zip", zip)).format, "zip");
    assert.equal(fingerprint(write("app.apk", zip)).format, "android-package");
    // An asar is named by its extension, whatever its first bytes are.
    assert.equal(
      fingerprint(write("app.asar", Buffer.alloc(64, 4))).format,
      "asar",
    );
    const archive = fingerprint(write("more.zip", zip));
    assert.equal(archive.kind, "archive");
    assert.match(archive.note, /REA's own tools/);
  });

  it("names a Dalvik executable", () => {
    const dex = Buffer.concat([
      Buffer.from("dex\n035\0", "latin1"),
      Buffer.alloc(32),
    ]);
    assert.equal(fingerprint(write("classes.dex", dex)).format, "dex");
  });
});

describe("errors", () => {
  it("is caught by the caller when a file cannot be read", () => {
    assert.throws(() => fingerprint(path.join(dir, "no-such-file")));
  });
});
