import { execFile } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import ollama from "ollama";
import OpenAI from "openai";

export const clients = {
  openai: new OpenAI(),
  anthropic: new Anthropic(),
  local: ollama,
};

export function stagedDiff(callback) {
  return execFile("git", ["diff", "--cached"], callback);
}
