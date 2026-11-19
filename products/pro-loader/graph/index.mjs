import { visitEvidence } from "./evidence.mjs";
import { ingestGraph } from "./ingest.mjs";
import { openWriter } from "./store.mjs";

export async function buildFreeGraph(dir, evidence) {
  const db = openWriter(dir);
  try {
    const existing = db.prepare("SELECT json FROM meta").get();
    if (existing && JSON.parse(existing.json).vector) {
      throw new Error(
        "This directory contains a Pro index. Choose another --store directory or rebuild with Pro.",
      );
    }
    db.exec("DELETE FROM edges; DELETE FROM nodes; DELETE FROM meta");
    const result = {
      ...(await ingestGraph(db, evidence, visitEvidence)),
      edition: "free",
    };
    db.prepare("INSERT INTO meta VALUES(?)").run(JSON.stringify(result));
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}
