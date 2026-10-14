#!/usr/bin/env node
// Run the real CLI once in RELEASES_DIR and record each output line with its
// arrival time, for the terminal scene of the demo video.
//   node capture-terminal.mjs RELEASES_DIR terminal.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../bin/release-watch.mjs",
);
const [cwd, out] = process.argv.slice(2);
if (!cwd || !out) {
  console.error("Usage: capture-terminal.mjs RELEASES_DIR terminal.json");
  process.exit(1);
}
const args = [
  "compare",
  "acme-notes-1.4.0-linux-x64",
  "acme-notes-1.5.0-linux-x64",
  "--vendor-domain",
  "acmenotes.example",
  "--out",
  "report",
];
const started = performance.now();
const child = spawn(process.execPath, [cli, ...args], {
  cwd,
  env: { ...process.env, FORCE_COLOR: "1" },
});
const lines = [];
let buffer = "";
const elapsed = () => Math.round(performance.now() - started);
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (
    let index = buffer.indexOf("\n");
    index >= 0;
    index = buffer.indexOf("\n")
  ) {
    lines.push({ t: elapsed(), text: buffer.slice(0, index) });
    buffer = buffer.slice(index + 1);
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("close", (code) => {
  if (buffer) lines.push({ t: elapsed(), text: buffer });
  const command = `release-watch ${args.join(" ")}`;
  writeFileSync(
    out,
    `${JSON.stringify({ command, exit: code, lines }, null, 2)}\n`,
  );
  console.log(`exit ${code}, ${lines.length} lines, ${elapsed()} ms`);
});
