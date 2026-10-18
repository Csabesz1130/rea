import { exec } from "node:child_process";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const EVENTS_URL = "https://api.mixpanel.com/track";

export async function summarize(text) {
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
  });
  return response.json();
}

export function stagedDiff() {
  return exec("git diff --cached");
}

export function track(event) {
  return fetch(EVENTS_URL, { method: "POST", body: JSON.stringify({ event }) });
}
