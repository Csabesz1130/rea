const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

function loadNotes(directory) {
  const file = path.join(directory, "notes.json");
  if (!existsSync(file)) return [{ id: 1, title: "Welcome to Acme Notes" }];
  return JSON.parse(readFileSync(file, "utf8"));
}

module.exports = { loadNotes };
