const render = (notes) => {
  const list = document.querySelector("#notes");
  list.replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement("li");
      item.textContent = note.title;
      return item;
    }),
  );
};

window.notes.list().then(render);

document.querySelector("#export").addEventListener("click", async () => {
  const destination = await window.notes.exportCsv();
  document.querySelector("#status").textContent = `Saved to ${destination}`;
});

document.querySelector("#sync").addEventListener("click", async () => {
  const result = await window.notes.sync();
  document.querySelector("#status").textContent =
    `Synced ${result.count} notes`;
});
