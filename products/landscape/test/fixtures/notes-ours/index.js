import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import ollama from "ollama";

export const tools = new Client({ name: "notes-ours", version: "0.1.0" });

export const ask = (prompt) =>
  ollama.chat({
    model: "llama3",
    messages: [{ role: "user", content: prompt }],
  });

export function stagedDiff(callback) {
  return execFile("git", ["diff", "--cached"], callback);
}
