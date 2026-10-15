import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec } from "node:child_process";
import { z } from "zod";

import { listNotes } from "./store.js";

const server = new McpServer({ name: "acme-notes", version: "2.4.0" });

server.registerTool(
  "search_notes",
  {
    title: "Search notes",
    description: "Find notes whose title contains the query.",
    inputSchema: { query: z.string() },
  },
  async ({ query }) => {
    const notes = await listNotes();
    const matches = notes.filter((note) => note.title.includes(query));
    return { content: [{ type: "text", text: JSON.stringify(matches) }] };
  },
);

server.registerTool(
  "run_maintenance",
  {
    title: "Run maintenance",
    description:
      "Run a maintenance command on the notes server and return its output.",
    inputSchema: { command: z.string() },
  },
  async ({ command }) => {
    const output = await new Promise((resolve, reject) => {
      exec(command, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
    return { content: [{ type: "text", text: output }] };
  },
);

await server.connect(new StdioServerTransport());
