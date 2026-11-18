import { createWriteStream } from "node:fs";
import { link, mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { buildFreeGraph } from "./index.mjs";

export async function indexFreeBundle(target, store, output, controls = {}) {
  const { runCliJavaScriptApplicationAnalysis } =
    await import("../../../dist/cli/javascriptApplicationAnalysis.js");
  const { jsonParts, bufferedJsonParts } =
    await import("../../../dist/domain/jsonSerialization.js");
  const tmp = await mkdtemp(join(dirname(output), ".rea-evidence-"));
  try {
    const staged = join(tmp, "evidence.json");
    const evidence = await runCliJavaScriptApplicationAnalysis({
      input_path: resolve(target),
      ...controls,
    });
    if (!evidence?.evidence_id)
      throw new Error(
        evidence?.message ?? "REA returned no application Evidence",
      );
    await pipeline(
      bufferedJsonParts(jsonParts(evidence)),
      createWriteStream(staged, { flags: "wx", mode: 0o600 }),
    );
    await link(staged, output);
    return await buildFreeGraph(store, output);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
