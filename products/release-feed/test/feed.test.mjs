// The feed through its public CLI against a registry on 127.0.0.1: npm,
// the integrity check, unpacking, Release Watch and REA all run for real
// on packages written for each case. The comparisons need REA built.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { skip } from "../../release-watch/test/cli-run.mjs";
import { failureOf } from "../src/compare.mjs";
import {
  isPackageName,
  predecessorOf,
  releasesBetween,
  stableAsOf,
} from "../src/npm.mjs";
import { sizing } from "../src/sizing.mjs";
import {
  SERVER,
  SERVER_WITH_SHELL,
  SERVER_WITH_SYNC,
  harness,
  manifest,
  release,
} from "./harness.mjs";
import { tarball } from "./registry.mjs";

const { registry, feed, feedFor } = harness();
let hook;
const alerts = [];

before(async () => {
  hook = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      alerts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(204).end();
    });
  });
  await new Promise((resolve) => hook.listen(0, "127.0.0.1", resolve));
});
after(() => new Promise((resolve) => hook.close(resolve)));

const allFiles = (directory) =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));

describe("a watched package", { skip }, () => {
  it("is recorded on first sight, compared on its next release and alerted once", async () => {
    registry.publish("notes-mcp", "1.0.0", release("notes-mcp", "1.0.0"));
    const { work, run, entries } = feedFor(["notes-mcp"]);
    const first = await run();
    assert.deepEqual(first.output.outcomes, { baseline: 1 });
    assert.deepEqual(entries(), []);

    registry.publish(
      "notes-mcp",
      "2.0.0",
      release("notes-mcp", "2.0.0", SERVER_WITH_SYNC),
    );
    const webhook = `http://127.0.0.1:${hook.address().port}/hook/s3cr3t-token`;
    const options = [
      "--alert-on",
      "high",
      "--base-url",
      "https://feed.example.com",
    ];
    const second = await run(options, { RELEASE_FEED_WEBHOOK_URL: webhook });
    assert.deepEqual(second.output.new_entries, [
      {
        id: "notes-mcp@1.0.0..2.0.0",
        status: "compared",
        changes: 2,
        highest: "critical",
        not_examined: 0,
      },
    ]);
    const [entry] = entries();
    assert.equal(entry.basis, "the release last seen");
    assert.deepEqual(
      entry.findings.map(({ rule, kind }) => `${rule} ${kind}`).sort(),
      ["RW-M01 change", "RW-N01 change"],
    );
    assert.match(entry.old.integrity, /^sha512-/);
    assert.equal(entry.evidence.length, 2);
    assert.match(entry.evidence[0].evidence_id, /^ev_/);

    // The site has the report and the feeds, and none of REA's Evidence.
    const site = path.join(work, "site");
    const report = "reports/notes-mcp/1.0.0_2.0.0/report.html";
    assert.ok(existsSync(path.join(site, report)));
    assert.ok(!allFiles(site).some((file) => file.includes("evidence")));
    // Nor where on this machine the feed runs.
    assert.ok(
      !allFiles(site).some((file) => readFileSync(file).includes(work)),
    );
    const page = readFileSync(path.join(site, "index.html"), "utf8");
    assert.match(page, /notes-mcp <span>1\.0\.0 → 2\.0\.0<\/span>/);
    const jsonFeed = JSON.parse(
      readFileSync(path.join(site, "feed.json"), "utf8"),
    );
    assert.equal(
      jsonFeed.items[0].title,
      "notes-mcp 1.0.0 → 2.0.0: 2 changes, highest critical",
    );
    assert.equal(jsonFeed.items[0].url, `https://feed.example.com/${report}`);
    assert.match(readFileSync(path.join(site, "feed.xml"), "utf8"), /<entry>/);

    // One alert, and the webhook's URL in no file the feed wrote.
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].text, /^notes-mcp 1\.0\.0 → 2\.0\.0: 2 changes/);
    assert.match(
      alerts[0].text,
      /\[critical\] RW-M01 MCP tool can start processes/,
    );
    assert.match(alerts[0].text, /https:\/\/feed\.example\.com\/reports\//);
    assert.ok(
      !allFiles(work).some((file) =>
        readFileSync(file).includes("s3cr3t-token"),
      ),
    );

    const third = await run(options, { RELEASE_FEED_WEBHOOK_URL: webhook });
    assert.deepEqual(third.output.outcomes, { unchanged: 1 });
    assert.equal(alerts.length, 1);
    const status = await feed(["status", "--work", work]);
    assert.equal(status.output.packages["notes-mcp"].latest, "2.0.0");
    assert.equal(status.output.entries, 1);
  });
});

describe("a package seen for the first time", { skip }, () => {
  it("compares the stable release as of --since and keeps Evidence within its budget", async () => {
    const versions = [
      ["1.0.0", "2026-01-10T00:00:00.000Z", SERVER, false],
      ["1.1.0", "2026-02-10T00:00:00.000Z", SERVER, false],
      ["2.0.0-beta.1", "2026-02-20T00:00:00.000Z", SERVER_WITH_SHELL, false],
      ["2.0.0", "2026-03-10T00:00:00.000Z", SERVER_WITH_SHELL, true],
    ];
    for (const [version, published, code, latest] of versions)
      registry.publish(
        "since-mcp",
        version,
        release("since-mcp", version, code),
        {
          published,
          latest,
        },
      );
    const { work, run, entries } = feedFor(["since-mcp"]);
    const before = alerts.length;
    const result = await run(
      ["--since", "2026-01-15", "--max-evidence-gb", "0", "--alert-on", "high"],
      {
        RELEASE_FEED_WEBHOOK_URL: `http://127.0.0.1:${hook.address().port}/hook`,
      },
    );
    assert.deepEqual(result.output.outcomes, { compared: 1 });
    const [entry] = entries();
    // What could not be examined is a note, not a change, and alerts nobody.
    assert.deepEqual(
      entry.findings
        .map(({ rule, kind, severity }) => `${rule} ${kind} ${severity}`)
        .sort(),
      ["RW-C01 coverage high", "RW-M02 change medium"],
    );
    assert.deepEqual(entry.changes, { count: 1, highest: "medium" });
    assert.equal(alerts.length, before);
    assert.match(
      readFileSync(path.join(work, "site/index.html"), "utf8"),
      /Not examined: Process calls in changed code of v2\.0\.0 were not classified\./,
    );
    assert.equal(entry.id, "since-mcp@1.0.0..2.0.0");
    assert.equal(entry.basis, "the stable release as of 2026-01-15");
    assert.equal(entry.releases_between, 3);
    assert.equal(entry.evidence_kept, false);
    const report = path.join(work, "reports/since-mcp/1.0.0_2.0.0");
    assert.ok(existsSync(path.join(report, "report.json")));
    assert.ok(!existsSync(path.join(report, "evidence")));
    // Only the release the next comparison starts from stays unpacked.
    assert.deepEqual(readdirSync(path.join(work, "packages")), [
      "since-mcp-2.0.0",
    ]);
  });
});

describe("a release that cannot be compared", () => {
  it("is an entry that says why, and an alert when the tarball itself is suspect", async () => {
    const names = ["tampered", "linked", "huge", "republished"];
    for (const name of names)
      registry.publish(name, "1.0.0", release(name, "1.0.0"));
    const { work, run, entries } = feedFor([...names, "never-published"]);
    const first = await run();
    assert.deepEqual(first.output.outcomes, { baseline: 4, unreachable: 1 });
    assert.deepEqual(first.output.unreachable, [
      { name: "never-published", reason: "not-found" },
    ]);

    // The registry states an integrity the tarball does not have.
    registry.publish("tampered", "2.0.0", release("tampered", "2.0.0"), {
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    });
    // The tarball holds a link out of the package.
    registry.publish(
      "linked",
      "2.0.0",
      tarball(
        { "package.json": manifest("linked", "2.0.0"), "index.js": SERVER },
        { "passwd.js": "/etc/passwd" },
      ),
    );
    // It unpacks to more than the run allows.
    registry.publish(
      "huge",
      "2.0.0",
      tarball({
        "package.json": manifest("huge", "2.0.0"),
        "data.js": `export default "${"x".repeat(3 * 2 ** 20)}";`,
      }),
    );
    // A release seen before is published again with other content.
    registry.publish(
      "republished",
      "1.0.0",
      release("republished", "1.0.0", SERVER_WITH_SHELL),
      { latest: false },
    );
    registry.publish("republished", "1.1.0", release("republished", "1.1.0"));

    const before = alerts.length;
    const second = await run(
      ["--max-unpacked-mb", "1", "--alert-on", "critical"],
      {
        RELEASE_FEED_WEBHOOK_URL: `http://127.0.0.1:${hook.address().port}/hook`,
      },
    );
    assert.equal(second.status, 0);
    assert.deepEqual(
      entries()
        .map((entry) => `${entry.id} ${entry.status} ${entry.reason}`)
        .sort(),
      [
        "huge@1.0.0..2.0.0 failed too-large",
        "linked@1.0.0..2.0.0 failed unsafe-entry",
        "republished@1.0.0..1.1.0 failed integrity-mismatch",
        "tampered@1.0.0..2.0.0 failed integrity-mismatch",
      ],
    );
    assert.match(
      entries().find((entry) => entry.package === "republished").detail,
      /^1\.0\.0: the tarball's integrity sha512-.* is not the expected sha512-/,
    );
    // Nothing stays unpacked of a comparison that did not happen, and
    // every package moves on.
    assert.deepEqual(readdirSync(path.join(work, "packages")), []);
    const third = await run();
    assert.deepEqual(third.output.outcomes, { unchanged: 4, unreachable: 1 });
    // Suspect tarballs alert whatever the threshold; a large one does not.
    assert.deepEqual(
      alerts
        .slice(before)
        .map((alert) => alert.entry.package)
        .sort(),
      ["linked", "republished", "tampered"],
    );
    assert.match(
      readFileSync(path.join(work, "site/index.html"), "utf8"),
      /Not compared: unsafe-entry\./,
    );
  });
});

describe("the feed's own safety", () => {
  it("lets one run at a time write a work directory", async () => {
    const { work, run } = feedFor(["never-published"]);
    const lock = path.join(work, "run.lock");
    // A live process holds it.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started: null }));
    const held = await run();
    assert.equal(held.status, 1);
    assert.match(held.stderr, /another run holds .*run\.lock \(pid \d+\)/);
    assert.ok(existsSync(lock));
    // Its pid now belongs to another process: the run that wrote it is gone.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started: "1" }));
    const taken = await run();
    assert.equal(taken.status, 0);
    assert.ok(!existsSync(lock));
  });

  it("refuses a watchlist or an option that is not what it takes", async () => {
    const { work, run } = feedFor(["--registry=http://127.0.0.1:1"]);
    const flag = await run();
    assert.equal(flag.status, 2);
    assert.match(flag.stderr, /names what npm would not accept as a package/);
    assert.ok(!existsSync(path.join(work, "state.json")));
    const since = await feedFor(["notes-mcp"]).run(["--since", "yesterday"]);
    assert.equal(since.status, 2);
    assert.ok(isPackageName("@scope/name.js"));
    assert.ok(!isPackageName("../escape"));
    assert.ok(!isPackageName("-flag"));
  });

  it("escapes what a release's text puts on the site and in the feeds", async () => {
    const { work } = feedFor(["notes-mcp"]);
    const hostile = '<script>alert(1)</script> \u202E"& \u0007';
    mkdirSync(path.join(work, "entries/notes-mcp"), { recursive: true });
    writeFileSync(
      path.join(work, "entries/notes-mcp/1.0.0_2.0.0.json"),
      JSON.stringify({
        schema: 1,
        id: "notes-mcp@1.0.0..2.0.0",
        package: "notes-mcp",
        slug: "notes-mcp",
        old: { version: "1.0.0", published: "2026-01-10T00:00:00.000Z" },
        new: {
          version: "2.0.0",
          published: "2026-02-10T00:00:00.000Z",
          license: hostile,
        },
        basis: "the release last seen",
        releases_between: 1,
        detected_at: "2026-02-11T00:00:00.000Z",
        status: "compared",
        report: "reports/notes-mcp/1.0.0_2.0.0",
        verdict: { highest: "high", errors: 0 },
        changes: { count: 1, highest: "high" },
        findings: [
          {
            id: "F1",
            rule: "RW-N02",
            severity: "high",
            kind: "change",
            title: hostile,
          },
          {
            id: "F2",
            rule: "RW-C01",
            severity: "high",
            kind: "coverage",
            title: hostile,
          },
        ],
        coverage: { old: [], new: [] },
      }),
    );
    const built = await feed([
      "site",
      "--work",
      work,
      "--title",
      hostile,
      "--no-reports",
    ]);
    assert.equal(built.output.entries, 1);
    const site = path.join(work, "site");
    for (const file of ["index.html", "feed.xml"]) {
      const text = readFileSync(path.join(site, file), "utf8");
      assert.ok(!text.includes("<script>alert"), file);
      assert.ok(!text.includes("\u202E") && !text.includes("\u0007"), file);
      assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, file);
    }
    assert.ok(!existsSync(path.join(site, "reports")));
    assert.ok(
      !readFileSync(path.join(site, "index.html"), "utf8").includes(
        "full report",
      ),
    );
  });
});

describe("which release a new one is compared with", () => {
  const versions = [
    ["1.0.0", "2026-01-01"],
    ["1.1.0", "2026-02-01"],
    ["2.0.0-rc.1", "2026-02-15"],
    ["2.0.0", "2026-03-01"],
    ["1.1.1", "2026-03-10"],
    ["2.0.1", "2026-03-20"],
    ["3.0.0-beta.1", "2026-04-01"],
  ].map(([version, day]) => ({ version, published: `${day}T12:00:00.000Z` }));

  it("is the stable release below it, not a later patch of an older line", () => {
    assert.equal(predecessorOf(versions, "2.0.1"), "2.0.0");
    assert.equal(predecessorOf(versions, "2.0.0"), "1.1.0");
    assert.equal(predecessorOf(versions, "1.1.1"), "1.1.0");
    assert.equal(predecessorOf(versions, "1.0.0"), null);
    // A prerelease follows whatever was published just before it.
    assert.equal(predecessorOf(versions, "3.0.0-beta.1"), "2.0.1");
    assert.equal(predecessorOf(versions, "9.9.9"), null);
  });

  it("or the stable release a reader had on a given day", () => {
    assert.equal(stableAsOf(versions, "2026-02-20", "2.0.1"), "1.1.0");
    assert.equal(stableAsOf(versions, "2026-03-05", "2.0.1"), "2.0.0");
    // The latest release was already out that day: nothing is new since.
    assert.equal(stableAsOf(versions, "2026-03-25", "2.0.1"), "2.0.1");
    assert.equal(stableAsOf(versions, "2025-12-31", "2.0.1"), null);
    // A higher number published long ago is not what latest named: the
    // release a reader had is one below the latest.
    const stray = [
      { version: "26.0.0", published: "2025-01-01T00:00:00.000Z" },
      ...versions,
    ];
    assert.equal(stableAsOf(stray, "2026-03-05", "2.0.1"), "2.0.0");
    assert.equal(stableAsOf(stray, "2026-03-25", "2.0.1"), "2.0.1");
    // A prerelease as latest is compared with the greatest stable release.
    assert.equal(stableAsOf(versions, "2026-03-25", "3.0.0-beta.1"), "2.0.1");
    assert.equal(releasesBetween(versions, "1.1.0", "2.0.1"), 4);
    assert.equal(releasesBetween(versions, "1.1.0", "0.0.1"), null);
  });
});

describe("sizing", () => {
  it("runs as many comparisons at once as both CPUs and memory allow", () => {
    const of = (cpus, gb) => {
      const { parallel, heapMb } = sizing({ cpus, memoryMb: gb * 1024 });
      return `${parallel} at ${heapMb} MB`;
    };
    assert.equal(of(2, 4), "1 at 3072 MB");
    assert.equal(of(4, 7.6), "1 at 5836 MB");
    assert.equal(of(8, 15.2), "2 at 5836 MB");
    assert.equal(of(16, 30.5), "4 at 5856 MB");
    assert.equal(of(48, 180), "24 at 5760 MB");
    assert.equal(of(2, 64), "1 at 8192 MB");
  });
});

describe("a comparison that ends without a report", () => {
  it("says it outgrew its heap rather than quoting V8's stack trace", () => {
    // What Node 22 wrote here when a process outgrew its heap, shortened.
    const trace = [
      "<--- Last few GCs --->",
      "",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      "----- Native stack trace -----",
      "",
      " 1: 0xe16044 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]",
      " 8: 0x1cc69b1  [/opt/node22/bin/node]",
      "",
    ].join("\n");
    assert.deepEqual(failureOf(trace, null, 8192), {
      ok: false,
      reason: "out-of-memory",
      detail:
        "Release Watch outgrew its 8192 MB heap; --heap-mb gives a comparison more",
    });
    assert.deepEqual(
      failureOf("a warning\nError: cannot read the release\n", 1, 8192),
      {
        ok: false,
        reason: "compare-failed",
        detail: "Error: cannot read the release",
      },
    );
    assert.equal(
      failureOf("", 3, 8192).detail,
      "Release Watch exited with status 3 and wrote no report",
    );
  });
});
