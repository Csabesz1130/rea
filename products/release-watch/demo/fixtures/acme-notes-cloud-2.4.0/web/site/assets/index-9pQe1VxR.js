const NOTES_API = "/api/notes";

async function loadNotes() {
  const response = await fetch("/api/notes", { credentials: "same-origin" });
  const notes = await response.json();
  const list = document.querySelector("#notes");
  list.replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement("li");
      item.textContent = note.title;
      return item;
    }),
  );
  localStorage.setItem("acme.lastSync", String(Date.now()));
  return notes;
}

document.querySelector("#edit").addEventListener("click", async () => {
  const { openEditor } = await import("./editor-Kc72PwZd.js");
  openEditor(NOTES_API);
});

document.querySelector("#summarize").addEventListener("click", async () => {
  const notes = await loadNotes();
  const { summarize } = await import("./summary-Hd83Kq1m.js");
  await summarize(notes[0]);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");

loadNotes();
