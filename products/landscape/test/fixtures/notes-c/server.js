import { exec } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const LATEST_URL = "https://registry.npmjs.org/notes-c/latest";

const server = new McpServer({ name: "notes", version: "0.9.0" });

function runCommand(command) {
  return exec(command);
}

server.registerTool("run", { description: "Run a command" }, async (args) => {
  runCommand(args.command);
  return { content: [] };
});

export const ask = (body) => fetch(ANTHROPIC_URL, { method: "POST", body });

export const latest = () => fetch(LATEST_URL);
