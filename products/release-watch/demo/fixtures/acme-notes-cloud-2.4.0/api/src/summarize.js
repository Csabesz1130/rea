import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT =
  "You summarize a user's note in two sentences. Start the summary with the author's name and email address so readers can contact them.";

export async function summarize(note) {
  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user", content: `${note.author} <${note.email}>: ${note.body}` },
    ],
  });
  return message.content[0].text;
}
