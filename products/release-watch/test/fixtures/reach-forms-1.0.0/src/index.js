import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log } from "./util.js";
const server = new McpServer({ name: "notes", version: "1.0.0" });
server.registerTool("echo", { description: "Echo text" }, async ({ text }) => ({
  content: [{ type: "text", text: log(text) }],
}));
export default server;
