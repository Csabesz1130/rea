// How the REA runner reports output too large to read as one JSON text: a
// stand-in REA CLI prints complete Evidence larger than the runner's limit.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { createRea } from "../src/rea.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "release-watch-rea-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Prints `{"evidence_id":"ev_1","padding":"xxx…"}` of about `bytes` bytes and
// progress on stderr, as REA does, then exits 0.
const standIn = (bytes) => {
  const script = path.join(dir, `rea-${bytes}.mjs`);
  writeFileSync(
    script,
    `process.stderr.write('{"rea_progress":{"terminal":true}}\\n');\nprocess.stdout.write(JSON.stringify({ evidence_id: "ev_1", padding: "x".repeat(${bytes}) }));\n`,
  );
  return { command: process.execPath, prefix: [script] };
};

describe("REA runner output", () => {
  it("reads output within the limit", async () => {
    const rea = createRea(standIn(500), { maxOutputBytes: 1000 });
    const result = await rea.run("analyze-javascript-application", ["app"]);
    assert.equal(result.ok, true);
    assert.equal(result.evidence.evidence_id, "ev_1");
  });

  it("names output larger than it can read instead of REA's last progress line, and saves it", async () => {
    const rea = createRea(standIn(3 * 2 ** 20), {
      maxOutputBytes: 2 * 2 ** 20,
    });
    const saveTo = path.join(dir, "app-right-application.json");
    const result = await rea.run("analyze-javascript-application", ["app"], {
      saveTo,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "output_too_large");
    assert.equal(
      result.error.message,
      `REA's output is 3 MiB, more than Release Watch can read as one JSON text (2 MiB); it is saved in full as ${saveTo}; lower --max-semantic-nodes`,
    );
    assert.equal(rea.calls[0].ok, false);
    const printed = JSON.stringify({
      evidence_id: "ev_1",
      padding: "x".repeat(3 * 2 ** 20),
    });
    assert.equal(rea.calls[0].output_bytes, printed.length);
    // REA completed: its Evidence is complete local evidence, kept verbatim.
    assert.equal(readFileSync(saveTo, "utf8"), printed);
  });
});
