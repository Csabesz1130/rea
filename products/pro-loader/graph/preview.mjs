import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { state } from "../auth.mjs";
import { remoteTrial, upgradeCommand } from "../trial-authority.mjs";
import { graphStats } from "./store.mjs";
import { graphAggregates } from "./aggregates.mjs";

const limit = 3;

// Open the same profile database as the previous daily preview. Transfer every
// retained old redemption once; that client discarded rows from previous days.
function openUsage() {
  const home = state();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "preview-usage.sqlite");
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=15000; BEGIN IMMEDIATE",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS graph_trial(singleton INTEGER PRIMARY KEY CHECK(singleton=1), used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 3))",
    );
    if (!db.prepare("SELECT 1 FROM graph_trial WHERE singleton=1").get()) {
      const legacy = db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='slices'",
        )
        .get();
      const used = legacy
        ? db
            .prepare("SELECT count(*) AS n FROM (SELECT 1 FROM slices LIMIT 3)")
            .get().n
        : 0;
      db.prepare("INSERT INTO graph_trial VALUES(1,?)").run(used);
      // Old clients that share the profile must never reset the lifetime count.
      db.exec("COMMIT; BEGIN IMMEDIATE");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function licenseRequired(store) {
  let meta = {};
  try {
    meta = graphStats(store);
  } catch {}
  const fields = graphAggregates(meta);
  return {
    status: "LICENSE_REQUIRED",
    indexed_nodes: fields.indexed_nodes,
    raw_evidence_tokens: fields.raw_evidence_tokens,
    sliced_tokens_ready: fields.sliced_tokens_ready,
    matched_subgraph_nodes: fields.matched_subgraph_nodes,
    upgrade_command: upgradeCommand(),
  };
}

function readUsed(db) {
  return db.prepare("SELECT used FROM graph_trial WHERE singleton=1").get()
    .used;
}

function localExhausted() {
  let db;
  try {
    db = openUsage();
    return readUsed(db) >= limit;
  } catch {
    return true;
  } finally {
    db?.close();
  }
}
async function allowed(check) {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}
export async function trialExhausted() {
  try {
    const account = remoteTrial();
    return account ? !(await allowed(account.available)) : localExhausted();
  } catch {
    return true;
  }
}

export async function trialQuery(store, run) {
  let account;
  try {
    account = remoteTrial();
  } catch {
    return licenseRequired(store);
  }
  if (account) {
    if (!(await allowed(account.available))) return licenseRequired(store);
    let value;
    try {
      value = run();
    } catch (error) {
      if (!(await allowed(account.available))) return licenseRequired(store);
      throw error;
    }
    return (await allowed(account.spend)) ? value : licenseRequired(store);
  }
  let db;
  try {
    db = openUsage();
  } catch {
    return licenseRequired(store);
  }
  try {
    if (readUsed(db) >= limit) return licenseRequired(store);
    const value = run();
    db.prepare("UPDATE graph_trial SET used=used+1 WHERE singleton=1").run();
    db.exec("COMMIT");
    return value;
  } finally {
    db.close();
  }
}
