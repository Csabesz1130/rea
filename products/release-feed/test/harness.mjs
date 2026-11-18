// What the feed's tests share: a registry on 127.0.0.1 for the test file
// that asks for one, the CLI run without blocking it, a work directory per
// feed, and releases of a small MCP server.
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { startRegistry, tarball } from "./registry.mjs";

const cli = fileURLToPath(new URL("../bin/release-feed.mjs", import.meta.url));

/**
 * Starts a registry for the calling test file, closed after its tests, and
 * returns `{ registry: { publish, url }, feed, feedFor }`: `feed(args, env)`
 * runs the CLI, `feedFor(packages)` makes a work directory with a
 * watchlist and returns `{ work, run, entries }`.
 */
export const harness = () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-feed-test-"));
  let live;
  before(async () => {
    live = await startRegistry();
  });
  after(async () => {
    await live.close();
    rmSync(root, { recursive: true, force: true });
  });
  const registry = {
    publish: (...args) => live.publish(...args),
    get url() {
      return live.url;
    },
  };

  // The CLI, without blocking the registry this process serves.
  const feed = (args, env = {}) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [cli, ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            npm_config_cache: path.join(root, "npm-cache"),
            ...env,
          },
        },
        (error, stdout, stderr) =>
          resolve({
            status: error ? (error.code ?? 1) : 0,
            stdout,
            stderr,
            output: stdout.startsWith("{") ? JSON.parse(stdout) : null,
          }),
      );
    });

  let count = 0;
  // A work directory and the watchlist for it.
  const feedFor = (packages) => {
    const work = path.join(root, `feed-${(count += 1)}`);
    mkdirSync(work, { recursive: true });
    const watchlist = path.join(work, "watchlist.json");
    writeFileSync(watchlist, JSON.stringify({ title: "Test feed", packages }));
    const run = (args = [], env = {}) =>
      feed(
        ["run", watchlist, "--work", work, "--registry", registry.url, ...args],
        env,
      );
    const entries = () =>
      JSON.parse(readFileSync(path.join(work, "site/api/entries.json"), "utf8"))
        .entries;
    return { work, run, entries };
  };
  return { registry, feed, feedFor };
};

export const manifest = (name, version) =>
  JSON.stringify({ name, version, type: "module", bin: "index.js" });
export const SERVER = [
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'const server = new McpServer({ name: "notes", version: "1.0.0" });',
  'server.registerTool("list", {}, async () => (await fetch("https://api.example.com/notes")).json());',
].join("\n");
// A tool that starts a process and calls a new host: changes Release Watch
// reports as such.
export const SERVER_WITH_SYNC = [
  'import { spawn } from "node:child_process";',
  SERVER,
  "const sync = async () => {",
  '  const child = spawn("git", ["pull"]);',
  '  await fetch("https://telemetry.example.net/sync");',
  "  return child.pid;",
  "};",
  'server.registerTool("sync", {}, sync);',
].join("\n");
// A process call REA does not classify, through a module loaded when the
// tool runs: Release Watch notes it as code it could not examine, beside
// one more tool registration.
export const SERVER_WITH_SHELL = [
  SERVER,
  "let cp;",
  'server.registerTool("run", {}, async ({ command }) => {',
  '  cp = require("node:child_process");',
  "  return cp.execSync(command).toString();",
  "});",
].join("\n");
export const release = (name, version, code = SERVER) =>
  tarball({ "package.json": manifest(name, version), "index.js": code });
