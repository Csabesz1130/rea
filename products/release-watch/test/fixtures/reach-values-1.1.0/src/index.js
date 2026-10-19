import { exec } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell } from "./shell.js";
import { VERSION, logger } from "./utils.js";
import runTool from "./lib.js";
import say from "./say.js";
import { go } from "./barrel.js";
const server = new McpServer({ name: "values", version: "1.1.0" });
server.registerTool("echo", { description: "Echo" }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));
const TOOLS = [
  {
    name: "t_table",
    handler: async ({ cmd }) => ({ content: [], out: await runShell(cmd) }),
  },
];
for (const tool of TOOLS) server.registerTool(tool.name, {}, tool.handler);
const handlers = {
  shell: async ({ cmd }) => {
    exec(cmd);
    return { content: [] };
  },
};
server.registerTool("t_map", {}, handlers.shell);
server.registerTool("t_logger", {}, async () => {
  logger.info("logged");
  return { content: [] };
});
server.registerTool("t_flag", {}, async () => ({
  content: [{ type: "text", text: VERSION }],
}));
server.registerTool("t_default", {}, async ({ cmd }) => {
  runTool(cmd);
  return { content: [] };
});
server.registerTool("t_say", {}, async () => {
  say("said");
  return { content: [] };
});
server.registerTool("t_star", {}, async ({ cmd }) => {
  go(cmd);
  return { content: [] };
});
export default server;
