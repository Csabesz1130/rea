import { readFile } from "node:fs/promises";

export async function listNotes() {
  const raw = await readFile(
    new URL("../data/notes.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(raw);
}
