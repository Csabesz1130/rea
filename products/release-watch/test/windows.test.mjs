// BrowserWindow pairing across releases: reorders, removals, moves between
// files and dynamic values, as REA reports windows without an identity.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { app, at, evaluate, fact, side } from "./helpers.mjs";

describe("BrowserWindow pairing", () => {
  const window = (file, preferences, line = 4, identity = {}) =>
    fact(
      `${file}@${line}`,
      {
        source_path: file,
        web_preferences: preferences,
        variable: identity.variable ?? null,
        loads: identity.loads ?? [],
      },
      at(file, line),
    );
  const sandbox = (value) => ({ sandbox: { known: true, value } });
  const graded = (before, after) =>
    evaluate(
      side("v1", app({ windows: before })),
      side("v2", app({ windows: after })),
    ).map((finding) => [finding.rule, finding.severity]);

  it("does not report windows that were only reordered", () => {
    assert.deepEqual(
      graded(
        [
          window("main.js", sandbox(true), 4, { variable: "main" }),
          window("main.js", sandbox(false), 9, { variable: "about" }),
        ],
        [
          window("main.js", sandbox(false), 4, { variable: "about" }),
          window("main.js", sandbox(true), 9, { variable: "main" }),
        ],
      ),
      [],
    );
  });

  it("grades a window that lost its sandbox while another window was removed", () => {
    assert.deepEqual(
      graded(
        [
          window("main.js", sandbox(true), 4, { variable: "main" }),
          window("main.js", sandbox(false), 9, { variable: "about" }),
        ],
        [window("main.js", sandbox(false), 4, { variable: "main" })],
      ),
      [["RW-E02", "high"]],
    );
  });

  it("follows a window into another file by what it loads", () => {
    assert.deepEqual(
      graded(
        [
          window("main.js", sandbox(true), 4, {
            loads: ["https://app.example/"],
          }),
          window("settings.js", sandbox(false), 4, {
            loads: ["settings.html"],
          }),
        ],
        [
          window("main-window.js", sandbox(false), 4, {
            loads: ["https://app.example/"],
          }),
          window("settings.js", sandbox(true), 4, { loads: ["settings.html"] }),
        ],
      ),
      [["RW-E02", "high"]],
    );
  });

  it("grades a window that loses its sandbox although another window was already unsafe", () => {
    const legacy = window("legacy.js", sandbox(false));
    const findings = evaluate(
      side("v1", app({ windows: [window("main.js", sandbox(true)), legacy] })),
      side("v2", app({ windows: [window("main.js", sandbox(false)), legacy] })),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity]),
      [["RW-E02", "high"]],
    );
  });

  it("grades a dynamic sandbox that becomes false at medium, noting the old state is not established", () => {
    const [finding] = evaluate(
      side(
        "v1",
        app({
          windows: [
            window("main.js", { sandbox: { known: false, value: "strict" } }),
          ],
        }),
      ),
      side("v2", app({ windows: [window("main.js", sandbox(false))] })),
    );
    assert.equal(finding.severity, "medium");
    assert.ok(
      finding.unknowns.some((unknown) =>
        /old state is not established/.test(unknown),
      ),
    );
  });
});
