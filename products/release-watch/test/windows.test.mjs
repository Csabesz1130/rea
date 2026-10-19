// BrowserWindow pairing across releases: reorders, removals, moves between
// files and components, and dynamic values, as REA reports windows without
// an identity.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pairReleaseWindows } from "../src/rules/window-pairing.mjs";
import { app, at, evaluate, fact, side } from "./helpers.mjs";

const window = (file, preferences, line = 4, identity = {}) =>
  fact(
    `${file}@${line}`,
    {
      source_path: file,
      web_preferences: preferences,
      unresolved_preferences: [],
      holder: identity.holder ?? null,
      scope: identity.scope ?? "",
      loads: identity.loads ?? [],
    },
    at(file, line),
  );
const sandbox = (value) => ({ sandbox: { known: true, value } });

describe("BrowserWindow pairing", () => {
  const graded = (before, after) =>
    evaluate(
      side("v1", app({ windows: before })),
      side("v2", app({ windows: after })),
    ).map((finding) => [finding.rule, finding.severity]);

  it("does not report windows that were only reordered", () => {
    assert.deepEqual(
      graded(
        [
          window("main.js", sandbox(true), 4, { holder: "main" }),
          window("main.js", sandbox(false), 9, { holder: "about" }),
        ],
        [
          window("main.js", sandbox(false), 4, { holder: "about" }),
          window("main.js", sandbox(true), 9, { holder: "main" }),
        ],
      ),
      [],
    );
  });

  it("grades a window that lost its sandbox while another window was removed", () => {
    assert.deepEqual(
      graded(
        [
          window("main.js", sandbox(true), 4, { holder: "main" }),
          window("main.js", sandbox(false), 9, { holder: "about" }),
        ],
        [window("main.js", sandbox(false), 4, { holder: "main" })],
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
            window("main.js", {
              sandbox: { known: false, value: "strict", compared: "strict" },
            }),
          ],
        }),
      ),
      side("v2", app({ windows: [window("main.js", sandbox(false))] })),
    );
    assert.equal(finding.severity, "medium");
    assert.equal(
      finding.title,
      "Renderer sandbox off, old value not established (sandbox: false)",
    );
    assert.ok(
      finding.unknowns.some((unknown) =>
        /old state is not established/.test(unknown),
      ),
    );
  });
});

describe("BrowserWindow pairing across components", () => {
  // Identity-less windows pair within their component before an old window
  // another component lost can explain them, so a changed window is not
  // hidden behind an identical one that moved.
  it("pairs a changed window with its own component's window before an identical one another component lost", () => {
    const paired = pairReleaseWindows([
      {
        name: "app",
        old: [window("main.js", sandbox(true))],
        now: [window("main.js", sandbox(false))],
      },
      { name: "legacy", old: [window("main.js", sandbox(false))], now: [] },
    ]).get("app");
    assert.deepEqual(
      paired.pairs.map(({ from, was }) => [
        from,
        was.data.web_preferences.sandbox.value,
      ]),
      [["app", true]],
    );
  });

  // Nothing but options relates the two windows: an existing component's new
  // window stays new, while a component new in the release may take it.
  it("pairs by options across components only for a component new in the release", () => {
    const removed = window("debug.js", sandbox(false));
    const added = window("market.js", sandbox(false));
    const shell = (newComponent) =>
      pairReleaseWindows([
        { name: "app", old: [removed], now: [] },
        { name: "shell", old: [], now: [added], newComponent },
      ]).get("shell");
    assert.deepEqual(shell(false), { pairs: [], added: [added] });
    assert.deepEqual(
      shell(true).pairs.map(({ was, from }) => [was, from]),
      [[removed, "app"]],
    );
  });
});
