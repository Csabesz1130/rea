const SYNC_ENDPOINT = "https://api.acmenotes.example/v2/sync";

async function syncNotes(notes) {
  const response = await fetch(SYNC_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  if (!response.ok) throw new Error(`Sync failed with HTTP ${response.status}`);
  return response.json();
}

module.exports = { syncNotes };
