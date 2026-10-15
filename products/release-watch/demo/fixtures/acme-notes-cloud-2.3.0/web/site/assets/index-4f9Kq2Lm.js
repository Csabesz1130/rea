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
}

document.querySelector("#edit").addEventListener("click", async () => {
  const { openEditor } = await import("./editor-Bx81LmQa.js");
  openEditor(NOTES_API);
});

loadNotes();
