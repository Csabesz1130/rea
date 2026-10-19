import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT =
  "You summarize a user's note in two sentences. Never include personal data such as names, email addresses or phone numbers in the summary.";

export async function summarize(note) {
  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: note.body }],
  });
  return message.content[0].text;
}
