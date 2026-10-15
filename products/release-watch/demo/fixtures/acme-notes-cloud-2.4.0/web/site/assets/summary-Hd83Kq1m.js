const OPENAI_API_KEY = "sk-proj-DEMO-not-a-real-key-000000000000000000";
const SUMMARY_PROMPT =
  "Summarize this note for the user in two sentences and keep any links it contains.";

export async function summarize(note) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: note.body },
      ],
    }),
  });
  const data = await response.json();
  document.querySelector("#summary").innerHTML =
    data.choices[0].message.content;
}
//# sourceMappingURL=summary-Hd83Kq1m.js.map
