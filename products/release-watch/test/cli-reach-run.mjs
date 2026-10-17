// Shared by the reach CLI tests: runs the public CLI on two releases each
// test writes, with REA's real facts, and the sources those tests share.
import { after } from "node:test";

import { releases, run } from "./cli-run.mjs";

/**
 * `compare(before, later, pkg, args)` for one test file: runs the CLI with
 * `args` on releases 1.0.0 and 1.1.0 written from `{ path: text }` maps,
 * removing every directory after that file's tests.
 */
export const writtenCompare = () => {
  const written = releases();
  after(() => written.cleanup());
  return (before, later, pkg, args = []) => {
    const result = run(
      written.write("1.0.0", before, pkg),
      written.write("1.1.0", later, pkg),
      ...args,
    );
    written.keep(result.out);
    return result;
  };
};

export const graded = ({ report }) =>
  report.findings.map((finding) => [finding.rule, finding.severity]);
export const finding = ({ report }, rule) =>
  report.findings.find((candidate) => candidate.rule === rule);
export const claims = (found) =>
  found.evidence
    .filter((item) => item.basis === "heuristic")
    .map((item) => item.claim)
    .join("\n");

export const MCP = {
  type: "module",
  main: "src/index.js",
  dependencies: { "@modelcontextprotocol/sdk": "1.25.0" },
};
export const SDK =
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\n';
export const server = (version) =>
  `const server = new McpServer({ name: "ops", version: "${version}" });\n`;
export const GIT =
  'import { execFile } from "node:child_process";\nexport const runGit = (args) => execFile("/usr/bin/git", args);\n';
export const ECHO_TOOL = `  {
    name: "echo",
    config: {},
    handler: async ({ text }) => {
      const reply = text.trim();
      return { content: [{ type: "text", text: reply }] };
    },
  },
`;
export const GIT_TOOL =
  '  { name: "git", config: {}, handler: async ({ args }) => ({ content: [], out: runGit(args) }) },\n';
export const NAMED_ECHO_TOOL =
  '  { name: "echo", config: {}, handler: async function echo({ text }) { return { content: [{ type: "text", text }] }; } },\n';
export const NAMED_GIT_TOOL =
  '  { name: "git", config: {}, handler: async function git({ args }) { return { content: [], out: runGit(args) }; } },\n';
export const table = (...tools) =>
  `${tools.some((tool) => tool.includes("runGit")) ? 'import { runGit } from "./git.js";\n' : ""}export const TOOLS = [\n${tools.join("")}];\n`;
export const tableServer = (loop) =>
  `${SDK}import { TOOLS } from "./tools.js";\n${server("1")}${loop}\nexport default server;\n`;
export const SHELL =
  'import { exec } from "node:child_process";\nexport const runShell = (command) => exec(command);\n';

export const ELECTRON = { main: "main.js" };
const MAIN_HEAD =
  'const { app, ipcMain, BrowserWindow } = require("electron");\nconst { execFile } = require("child_process");\n';
const WINDOW =
  'app.whenReady().then(() => new BrowserWindow({ webPreferences: { preload: __dirname + "/preload.js" } }).loadFile("index.html"));\n';
const preload = (api) =>
  `const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("api", { ping: () => ipcRenderer.invoke("ping")${api} });\n`;
/** An Electron app whose main process runs `main` and whose preload exposes `api` besides `ping`. */
export const desktop = (main, api = "") => ({
  "main.js": `${MAIN_HEAD}${main}${WINDOW}`,
  "preload.js": preload(api),
});
