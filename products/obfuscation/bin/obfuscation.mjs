#!/usr/bin/env node
// obfuscation scan <path>... : report how each file's contents are shaped —
// minified or bundled JavaScript, a packer's markers in a native binary, or
// an archive another tool must open. Read-only: nothing is unpacked or run.
import { parseArgs } from "node:util";

import { fingerprint } from "../src/fingerprint.mjs";

const USAGE = `Usage:
  obfuscation scan <path>...

Reports, read-only, how each file's contents are shaped:
  - JavaScript: the bundler it names and whether it looks minified, with the
    line measurements the judgement rests on;
  - a native executable (ELF, Mach-O, PE): the markers of a packer (UPX and
    the like) and the entropy of a sample;
  - an archive (zip, APK, jar, asar, dex): named, to be opened with REA's own
    android, apktool, jeb or asar tools.

It opens each file and reads a head and a tail window and an entropy sample.
It does not unpack, decompress, unminify or run anything; a packer marker is
an observation of the file's bytes, not a recovery of what the packer hid.

Output is JSON on stdout: one result per file. Exit status: 0 done (a file
that could not be read is a result with an error), 2 usage.`;

const usage = (message) => {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
} catch (error) {
  usage(error.message);
}
if (parsed.values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const [command, ...paths] = parsed.positionals;
if (command !== "scan")
  usage(command ? `Unknown command: ${command}` : "Name the command: scan.");
if (paths.length === 0) usage("Name at least one file to scan.");

const results = paths.map((path) => {
  try {
    return fingerprint(path);
  } catch (error) {
    return { file: path, kind: "error", error: error.message };
  }
});
process.stdout.write(`${JSON.stringify({ results }, null, 1)}\n`);
