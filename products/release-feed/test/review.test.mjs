// Review of a feed through its public CLI against a registry on 127.0.0.1:
// which release counts as accepted, where each comparison stands, what a
// person's verdict changes and what the gate lets through. The comparisons
// need REA built.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { skip } from "../../release-watch/test/cli-run.mjs";
import { standingOf } from "../src/review.mjs";
import {
  SERVER,
  SERVER_WITH_SHELL,
  SERVER_WITH_SYNC,
  harness,
  release,
} from "./harness.mjs";

const { registry, feed, feedFor } = harness();

// The same server with one more export: nothing a rule reports.
const SERVER_LABELLED = `${SERVER}\nexport const label = "notes";`;
// A process call REA does not classify, outside any tool: a note on code
// that was not examined, and no change.
const SERVER_WITH_HELPER = [
  SERVER,
  "let cp;",
  "export const run = (command) => {",
  '  cp = require("node:child_process");',
  "  return cp.execSync(command).toString();",
  "};",
].join("\n");

// One feed for the whole story: each case starts where the last one ended.
let review;
const publish = (version, code) =>
  registry.publish("gate-mcp", version, release("gate-mcp", version, code));
const gate = (version) =>
  feed(["gate", `gate-mcp@${version}`, "--work", review.work]);
const verdict = (command, id, ...more) =>
  feed([command, id, "--work", review.work, ...more]);

describe("a feed in review", { skip }, () => {
  it("accepts the first release seen and clears one that changes nothing", async () => {
    publish("1.0.0", SERVER);
    review = feedFor(["gate-mcp"]);
    assert.deepEqual((await review.run(["--review"])).output.outcomes, {
      baseline: 1,
    });
    const first = await gate("1.0.0");
    assert.equal(first.status, 0);
    assert.equal(first.output.releases[0].why, "first sight");

    publish("1.0.1", SERVER_LABELLED);
    // The work directory stays in review without the option.
    const run = await review.run();
    assert.equal(run.output.new_entries[0].state, "cleared");
    assert.equal((await gate("1.0.1")).status, 0);
    assert.equal(
      (await gate("1.0.0")).output.releases[0].why,
      "accepted earlier",
    );
  });

  it("holds a release not examined in full, and compares the next with the accepted one", async () => {
    publish("1.1.0", SERVER_WITH_HELPER);
    const held = await review.run();
    assert.deepEqual(held.output.new_entries[0], {
      id: "gate-mcp@1.0.1..1.1.0",
      status: "compared",
      changes: 0,
      highest: null,
      not_examined: 1,
      state: "not-established",
    });
    const refused = await gate("1.1.0");
    assert.equal(refused.status, 3);
    assert.equal(refused.output.releases[0].state, "not-established");

    publish("2.0.0", SERVER_WITH_SYNC);
    const next = await review.run();
    assert.equal(next.output.new_entries[0].id, "gate-mcp@1.0.1..2.0.0");
    assert.equal(next.output.new_entries[0].state, "needs-review");
    const [newest, earlier] = review.entries();
    assert.equal(newest.basis, "the release last accepted");
    assert.equal(earlier.review.superseded_by, "gate-mcp@1.0.1..2.0.0");
    const waiting = await feed(["review", "--work", review.work]);
    assert.deepEqual(
      waiting.output.waiting.map(({ id, state }) => `${id} ${state}`),
      ["gate-mcp@1.0.1..2.0.0 needs-review"],
    );
    assert.equal(waiting.output.accepted["gate-mcp"].version, "1.0.1");
  });
});

describe("a person's verdict", { skip }, () => {
  it("records a person's verdict with the Evidence it was made on", async () => {
    const replaced = await verdict(
      "approve",
      "gate-mcp@1.0.1..1.1.0",
      "--by",
      "ana",
    );
    assert.equal(replaced.status, 1);
    assert.match(replaced.stderr, /replaced by gate-mcp@1\.0\.1\.\.2\.0\.0/);
    assert.equal((await verdict("approve", "gate-mcp@1.0.1..2.0.0")).status, 2);

    const approved = await verdict(
      "approve",
      "gate-mcp@1.0.1..2.0.0",
      "--by",
      "ana",
      "--note",
      "sync reviewed",
    );
    assert.equal(approved.output.state, "approved by ana");
    assert.equal((await gate("2.0.0")).status, 0);
    const [decision] = readFileSync(
      path.join(review.work, "decisions.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(decision.verdict, "approved");
    assert.equal(decision.note, "sync reviewed");
    assert.equal(decision.standing, "needs-review");
    assert.equal(decision.evidence.length, 2);
    assert.match(decision.evidence[0].root_sha256, /^[0-9a-f]{64}$/);

    const again = await verdict(
      "approve",
      "gate-mcp@1.0.1..2.0.0",
      "--by",
      "ben",
    );
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already approved by ana/);
    assert.deepEqual((await review.run()).output.outcomes, { unchanged: 1 });
    const page = readFileSync(
      path.join(review.work, "site/index.html"),
      "utf8",
    );
    assert.match(page, /<b>approved by ana<\/b>/);
    assert.match(page, /<b>0<\/b> waiting for a decision/);
  });

  it("keeps the accepted release when a person rejects", async () => {
    // 3.0.0 swaps the sync tool for one whose process call REA does not
    // classify: no change a rule reports, and code that was not examined.
    // The feed does not clear it; a person decides.
    publish("3.0.0", SERVER_WITH_SHELL);
    assert.equal(
      (await review.run()).output.new_entries[0].state,
      "not-established",
    );
    const rejected = await verdict(
      "reject",
      "gate-mcp@2.0.0..3.0.0",
      "--by",
      "ben",
    );
    assert.equal(rejected.output.state, "rejected by ben");
    const refused = await gate("3.0.0");
    assert.equal(refused.status, 3);
    assert.equal(refused.output.releases[0].state, "rejected");

    // The next release is compared with 2.0.0, whose code it has again.
    publish("3.0.1", SERVER_WITH_SYNC);
    const run = await review.run();
    assert.equal(run.output.new_entries[0].id, "gate-mcp@2.0.0..3.0.1");
    assert.equal(run.output.new_entries[0].state, "cleared");
    assert.equal((await gate("3.0.1")).status, 0);
  });
});

describe("where a comparison stands", () => {
  const entry = (findings, extra = {}) => ({
    status: "compared",
    verdict: { errors: 0 },
    coverage: { old: [], new: [] },
    findings,
    ...extra,
  });
  const change = (severity) => ({ kind: "change", severity });

  it("is cleared only without a change and with all code examined", () => {
    assert.equal(standingOf(entry([]), "low"), "cleared");
    assert.equal(standingOf(entry([change("low")]), "low"), "needs-review");
    // A change below what needs a person does not hold a release.
    assert.equal(standingOf(entry([change("low")]), "medium"), "cleared");
    assert.equal(
      standingOf(entry([{ kind: "coverage", severity: "high" }]), "low"),
      "not-established",
    );
    assert.equal(
      standingOf(entry([], { coverage: { old: [], new: ["partial"] } }), "low"),
      "not-established",
    );
    assert.equal(
      standingOf(entry([], { verdict: { errors: 1 } }), "low"),
      "not-established",
    );
    assert.equal(
      standingOf({ status: "failed", reason: "out-of-memory" }, "low"),
      "not-compared",
    );
  });

  it("is asked only of a feed in review, about releases named in full", async () => {
    const { work, run } = feedFor(["no-such-package-for-review"]);
    await run();
    const off = await feed(["gate", "a@1.0.0", "--work", work]);
    assert.equal(off.status, 1);
    assert.match(off.stderr, /not in review mode/);
    assert.equal((await feed(["gate", "a", "--work", work])).status, 2);
    assert.equal((await feed(["approve", "x", "--work", work])).status, 2);
  });
});
