#!/usr/bin/env node
// release-feed run <watchlist.json> --work <dir> [options]
// release-feed site --work <dir> [options]
// release-feed status --work <dir>
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { THRESHOLDS, sendAlerts } from "../src/alert.mjs";
import { endComparisons } from "../src/compare.mjs";
import { isPackageName } from "../src/npm.mjs";
import { pruneEvidence, runFeed } from "../src/run.mjs";
import { buildSite } from "../src/site.mjs";
import { sizing } from "../src/sizing.mjs";
import {
  acquireLock,
  readEntries,
  readState,
  writeJson,
} from "../src/state.mjs";

const USAGE = `Usage:
  release-feed run <watchlist.json> --work <dir> [options]
  release-feed site --work <dir> [--title <text>] [--base-url <url>] [--no-reports]
  release-feed status --work <dir>

run: asks the npm registry for the latest release of every package in the
watchlist ({ "title": "...", "packages": ["name", ...] }). A release not
seen before is fetched with the release it follows, each checked against
the registry's sha512 integrity, and compared with Release Watch; the
outcome becomes an entry of the feed. Then the site is built again
(<dir>/site: index.html, feed.xml, feed.json, api/entries.json and each
comparison's report) and alerts are sent. Nothing downloaded is run.

  --work <dir>            Where the feed keeps its state, reports and site
  --since <YYYY-MM-DD>    On first sight of a package, compare the stable
                          release as of that day with the latest one
  --backfill              On first sight, without --since, compare the
                          release before the latest one with it (default:
                          only record the latest)
  --parallel <n>          Comparisons at once (default: what this machine's
                          CPUs and memory allow)
  --heap-mb <n>           Node heap of each comparison (default: from memory)
  --timeout-min <n>       Time limit of one comparison (default: 30)
  --depth <depth>         standard | deep: how much of a large release REA
                          examines (Release Watch's --depth; default:
                          standard). deep takes more time
  --max-unpacked-mb <n>   Largest release to unpack (default: 300)
  --max-evidence-gb <n>   REA Evidence to keep; the oldest goes first
                          (default: 10)
  --registry <url>        npm registry to ask (default: npm's own setting)
  --title <text>          The site's and the feeds' title (default: the
                          watchlist's title)
  --base-url <url>        Where the site is served, for absolute feed links
  --no-reports            Leave the full reports, which quote lines of the
                          packages' code, out of the site
  --alert-on <severity>   critical | high | medium | low | info | never: POST
                          an alert for a comparison with a change at or
                          above it to the URL in RELEASE_FEED_WEBHOOK_URL
                          (default: high; no URL, no alerts)

site: builds the site again from the entries, without asking the registry.

status: prints the last run's summary, what each package was last seen
at, and this machine's sizing.

Exit status: 0 when the command completed (a release that could not be
compared is an entry that says why), 1 when it could not run (another run
holds the lock, or the state cannot be read), 2 on usage errors.`;

const usage = (message) => {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({
    options: {
      work: { type: "string" },
      since: { type: "string" },
      backfill: { type: "boolean" },
      parallel: { type: "string" },
      "heap-mb": { type: "string" },
      "timeout-min": { type: "string" },
      depth: { type: "string" },
      "max-unpacked-mb": { type: "string" },
      "max-evidence-gb": { type: "string" },
      registry: { type: "string" },
      title: { type: "string" },
      "base-url": { type: "string" },
      "no-reports": { type: "boolean" },
      "alert-on": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
} catch (error) {
  usage(error.message);
}
const { values, positionals } = parsed;
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const [command, target] = positionals;
if (!["run", "site", "status"].includes(command))
  usage(
    command
      ? `Unknown command: ${command}`
      : "Name a command: run, site or status.",
  );
if (!values.work) usage("Name the work directory with --work.");
const work = path.resolve(values.work);

// A whole number option at least `min`, or the default when not given.
const count = (name, fallback, min = 1) => {
  if (values[name] === undefined) return fallback;
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < min)
    usage(`--${name} takes a whole number of at least ${min}.`);
  return value;
};

const siteOptions = (extra = {}) => {
  if (
    values["base-url"] !== undefined &&
    !/^https?:\/\/[^\s]+$/.test(values["base-url"])
  )
    usage("--base-url takes an http or https URL.");
  return {
    title: values.title,
    baseUrl: values["base-url"],
    reports: values["no-reports"] !== true,
    ...extra,
  };
};

const readWatchlist = (file) => {
  if (!file) usage("Name the watchlist file.");
  let watchlist;
  try {
    watchlist = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    usage(`Cannot read ${file} as JSON: ${error.message}`);
  }
  if (!Array.isArray(watchlist?.packages) || watchlist.packages.length === 0)
    usage(`${file} needs "packages": a list of npm package names.`);
  const invalid = watchlist.packages.filter((name) => !isPackageName(name));
  if (invalid.length > 0)
    usage(
      `${file} names what npm would not accept as a package: ${invalid.map(String).join(", ")}`,
    );
  return {
    title: typeof watchlist.title === "string" ? watchlist.title : undefined,
    packages: [...new Set(watchlist.packages)],
  };
};

const fail = (message) => {
  process.stderr.write(`release-feed: ${message}\n`);
  process.exit(1);
};

const lastRunFile = path.join(work, "last-run.json");

if (command === "status") {
  let state;
  try {
    state = readState(work);
  } catch (error) {
    fail(error.message);
  }
  const output = {
    last_run: existsSync(lastRunFile)
      ? JSON.parse(readFileSync(lastRunFile, "utf8"))
      : null,
    packages: state.packages,
    entries: readEntries(work).length,
    sizing: sizing(),
  };
  process.stdout.write(`${JSON.stringify(output, null, 1)}\n`);
} else if (command === "site") {
  // What the last run watched and when: the state has every package, also
  // those with no entry yet.
  let state;
  try {
    state = readState(work);
  } catch (error) {
    fail(error.message);
  }
  const checked = Object.values(state.packages)
    .map((seen) => seen.checked_at)
    .filter(Boolean)
    .sort()
    .at(-1);
  const site = buildSite(
    work,
    siteOptions({
      watched: Object.keys(state.packages).length || undefined,
      checkedAt: checked,
    }),
  );
  process.stdout.write(`${JSON.stringify(site, null, 1)}\n`);
} else {
  const watchlist = readWatchlist(target);
  if (values.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.since))
    usage("--since takes a day as YYYY-MM-DD.");
  const threshold = values["alert-on"] ?? "high";
  if (!THRESHOLDS.includes(threshold))
    usage(`--alert-on takes one of ${THRESHOLDS.join(", ")}.`);
  const depth = values.depth ?? "standard";
  if (!["standard", "deep"].includes(depth))
    usage("--depth takes standard or deep.");
  const machine = sizing();
  const parallel = count("parallel", machine.parallel);
  const heapMb = count("heap-mb", machine.heapMb, 256);
  const site = siteOptions({ title: values.title ?? watchlist.title });
  const evidenceBytes = count("max-evidence-gb", 10, 0) * 2 ** 30;
  let release;
  let state;
  try {
    release = acquireLock(work);
    state = readState(work);
  } catch (error) {
    release?.();
    fail(error.message);
  }
  const stop = (signal) => {
    endComparisons();
    release();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  const started = performance.now();
  try {
    const results = await runFeed(watchlist.packages, {
      work,
      state,
      npm: { registry: values.registry },
      since: values.since,
      backfill: values.backfill === true,
      maxUnpackedBytes: count("max-unpacked-mb", 300) * 2 ** 20,
      heapMb,
      timeoutMs: count("timeout-min", 30) * 60000,
      depth,
      parallel,
      now: () => new Date().toISOString(),
      onResult: (result) => {
        // Evidence is pruned as it comes, so a long run stays in budget.
        if (result.outcome === "compared") pruneEvidence(work, evidenceBytes);
        process.stderr.write(
          `  ${result.name}: ${result.outcome}${result.entry ? ` ${result.entry.old.version} → ${result.entry.new.version}` : ""}${(result.reason ?? result.entry?.reason) ? ` (${result.reason ?? result.entry.reason})` : ""}\n`,
        );
      },
    });
    const pruned = readEntries(work).filter(
      (entry) => entry.evidence_kept === false,
    ).length;
    const built = buildSite(work, {
      ...site,
      watched: watchlist.packages.length,
      checkedAt: new Date().toISOString(),
    });
    const alerts = await sendAlerts(work, readEntries(work), {
      url: process.env.RELEASE_FEED_WEBHOOK_URL,
      threshold,
      baseUrl: site.baseUrl?.replace(/\/+$/, ""),
    });
    const outcomes = {};
    for (const { outcome } of results)
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    const summary = {
      finished_at: new Date().toISOString(),
      elapsed_s: Math.round(performance.now() - started) / 1000,
      watched: watchlist.packages.length,
      outcomes,
      new_entries: results
        .filter((result) => result.entry)
        .map(({ entry }) => ({
          id: entry.id,
          status: entry.status,
          ...(entry.status === "compared"
            ? {
                changes: entry.changes.count,
                highest: entry.changes.highest,
                not_examined: entry.findings.length - entry.changes.count,
              }
            : { reason: entry.reason }),
        })),
      unreachable: results
        .filter((result) => result.outcome === "unreachable")
        .map(({ name, reason }) => ({ name, reason })),
      alerts,
      entries_without_evidence: pruned,
      site: built.directory,
      sizing: { ...machine, parallel, heapMb },
    };
    writeJson(lastRunFile, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
  } finally {
    release();
  }
}
