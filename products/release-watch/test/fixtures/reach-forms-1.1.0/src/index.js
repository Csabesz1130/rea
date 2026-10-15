import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log } from "./util.js";
import { runShell as sh } from "./shell.js";
import * as shell from "./shell.js";
import { runTool } from "./lib.js";
import registerLegacy from "./legacy-tool.cjs";
const server = new McpServer({ name: "notes", version: "1.1.0" });
server.registerTool("echo", { description: "Echo text" }, async ({ text }) => ({
  content: [{ type: "text", text: log(text) }],
}));
server.registerTool("time", { description: "Current time" }, async () => {
  const result = new Date().toISOString();
  return { content: [{ type: "text", text: result }] };
});
server.registerTool("alias_run", { description: "Run" }, async ({ cmd }) => {
  sh(cmd);
  return { content: [] };
});
server.registerTool("ns_run", { description: "Run" }, async ({ cmd }) => {
  shell.runShell(cmd);
  return { content: [] };
});
server.registerTool("two_hop", { description: "Run" }, async ({ cmd }) => {
  runTool(cmd);
  return { content: [] };
});
registerLegacy(server);
export default server;
