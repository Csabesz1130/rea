import { createWriteStream, lstatSync } from "node:fs";
import { link, mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { trialQuery, trialExhausted } from "./preview.mjs";
import { pipeline } from "node:stream/promises";
import { buildFreeGraph } from "./index.mjs";

export async function indexFreeBundle(target, store, output, controls = {}) {
  const { runCliJavaScriptApplicationAnalysis } =
    await import("../../../dist/cli/javascriptApplicationAnalysis.js");
  const { silentProgressReporter } =
    await import("../../../dist/application/ProgressReporter.js");
  const { jsonParts, bufferedJsonParts } =
    await import("../../../dist/domain/jsonSerialization.js");
  const requestExport = Boolean(output) && !(await trialExhausted());
  const tmp = await mkdtemp(
    join(requestExport ? dirname(output) : tmpdir(), ".rea-evidence-"),
  );
  try {
    const staged = join(tmp, "evidence.json");
    const evidence = await runCliJavaScriptApplicationAnalysis(
      {
        input_path: resolve(target),
        ...controls,
      },
      undefined,
      silentProgressReporter,
    );
    if (!evidence?.evidence_id)
      throw new Error(
        evidence?.message ?? "REA returned no application Evidence",
      );
    await pipeline(
      bufferedJsonParts(jsonParts(evidence)),
      createWriteStream(staged, { flags: "wx", mode: 0o600 }),
    );
    const meta = await buildFreeGraph(store, staged);
    if (!requestExport) return { meta, exported: false };
    const granted = await trialQuery(store, () => {
      try {
        lstatSync(output);
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
      throw new Error("Evidence output already exists");
    });
    if (granted !== true) return { meta, exported: false };
    // Same-filesystem hard link publishes the completed file atomically and
    // preserves any destination created concurrently after entitlement approval.
    await link(staged, output);
    return { meta, exported: true };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
