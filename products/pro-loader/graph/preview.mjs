import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { state } from "../auth.mjs";
import { queryGraph, readSlice, source } from "./store.mjs";

const dailyLimit = 3;
// Billing is enforced by the private package service. The open-source preview's
// allowance is intentionally local and never sends graph contents to the issuer.
export function previewSlice(dir, input, now = new Date()) {
  return queryGraph(dir, (graph, meta) => {
    if (
      input.evidence_id !== undefined &&
      input.evidence_id !== meta.evidence_id
    ) {
      throw new Error(
        "Graph Evidence changed. Repeat the search against the current index",
      );
    }
    const day = now.toISOString().slice(0, 10);
    const resetsAt = new Date(
      Date.parse(day + "T00:00:00Z") + 86400000,
    ).toISOString();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          meta.input_sha256,
          meta.evidence_id,
          input.id,
          input.direction,
          input.relation ?? null,
          input.hops,
          input.budget,
        ]),
      )
      .digest("hex");
    const profile = state();
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const path = join(profile, "preview-usage.sqlite");
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "PRAGMA busy_timeout=15000; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS slices(day TEXT, fingerprint TEXT, PRIMARY KEY(day,fingerprint)) WITHOUT ROWID",
      );
      db.prepare("DELETE FROM slices WHERE day<?").run(day);
      const retry = db
        .prepare("SELECT 1 FROM slices WHERE day=? AND fingerprint=?")
        .get(day, fingerprint);
      if (
        !retry &&
        db.prepare("SELECT count(*) AS n FROM slices WHERE day=?").get(day).n >=
          dailyLimit
      ) {
        return {
          ...source(meta),
          code: "FREE_DAILY_SLICE_LIMIT",
          indexed_nodes: meta.nodes,
          daily_limit: dailyLimit,
          resets_at: resetsAt,
          message:
            "All three free slices have been used today. Exact-name search is unlimited. Run rea pro login for a Pro subscription.",
        };
      }
      const result = readSlice(graph, meta, input.id, input);
      if (!retry)
        db.prepare("INSERT INTO slices VALUES(?,?)").run(day, fingerprint);
      db.exec("COMMIT");
      return result;
    } finally {
      db.close();
    }
  });
}
