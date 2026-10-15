import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
const server = new McpServer({ name: "values", version: "1.0.0" });
server.registerTool("echo", { description: "Echo" }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));
export default server;
