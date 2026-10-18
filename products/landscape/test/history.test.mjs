// Runs `landscape history` on releases each test writes, with the REA build
// in this checkout. Skipped when REA has not been built.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { landscape, skip, written } from "./cli-run.mjs";

const SUMMARIZE =
  'const OPENAI_URL = "https://api.openai.com/v1/chat/completions";\nexport const summarize = (text) => fetch(OPENAI_URL, { method: "POST", body: text });\n';
const TRACK =
  'const EVENTS_URL = "https://api.mixpanel.com/track";\nexport const track = (event) => fetch(EVENTS_URL, { method: "POST", body: event });\n';
const LOCAL = 'import ollama from "ollama";\nexport const local = ollama;\n';

describe("history: one product across three releases", { skip }, () => {
  const releases = written();
  after(() => releases.cleanup());

  it("reports what each release gained and lost", () => {
    const run = landscape(
      "history",
      [
        releases.write("notes", "1.0.0", { "index.js": SUMMARIZE }),
        releases.write("notes", "1.1.0", {
          "index.js": `${SUMMARIZE}${TRACK}`,
          "local.js": LOCAL,
        }),
        releases.write("notes", "1.2.0", {
          "index.js": SUMMARIZE,
          "local.js": LOCAL,
        }),
      ],
      ["--category", "Notes"],
    );
    releases.keep(run.out);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(run.report.mode, "history");
    assert.deepEqual(
      run.report.trajectory.changes.map(({ row, kind, version, adjacent }) => [
        row,
        kind,
        version,
        adjacent,
      ]),
      [
        ["ai.local-model", "appeared", "p2", true],
        ["data.telemetry", "appeared", "p2", true],
        ["data.telemetry", "disappeared", "p3", true],
      ],
    );
    assert.deepEqual(
      run.report.trajectory.present.map(({ row }) => row),
      ["ai.provider:OpenAI", "ai.hosted", "data.remote"],
    );
    assert.match(
      run.outputs["report.md"],
      /### notes 1\.2\.0\n\n- No longer seen: Sends analytics, telemetry or error reports/,
    );
    assert.equal(run.outputs["brief.md"], "");
    assert.deepEqual(run.report.openings, []);
  });
});
