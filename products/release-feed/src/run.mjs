// One run of the feed: ask the registry what each watched package's latest
// release is, compare a release not seen before with the one it follows,
// and record the outcome as an entry. A package whose latest release was
// already seen costs one registry call.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import {
  isCoverageRule,
  maxSeverity,
} from "../../release-watch/src/rules/shared.mjs";
import { compareReleases } from "./compare.mjs";
import {
  fetchPackage,
  packageFacts,
  predecessorOf,
  releasesBetween,
  slugOf,
  stableAsOf,
  versionFacts,
} from "./npm.mjs";
import { SCHEMA, readEntries, writeEntry, writeState } from "./state.mjs";

// Failures that say nothing about the release: the next run tries again.
const TRANSIENT = new Set([
  "registry-timeout",
  "registry-error",
  "registry-answer",
]);

// Runs `task` over `items`, `size` at a time, in order of arrival.
const pool = async (items, size, task) => {
  const queue = [...items.entries()];
  const results = Array.from({ length: items.length });
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift())
      results[next[0]] = await task(next[1]);
  };
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, worker),
  );
  return results;
};

// What an entry keeps of Release Watch's report: the verdict; each finding
// without its evidence (the report holds that), as a change in the release
// or a note on what the analysis could not examine; the changes' count
// and highest severity; what REA could not examine on each side; and the
// Evidence each side's facts come from.
export const summaryOf = (report) => {
  const findings = report.findings.map(
    ({ id, rule, severity, title, summary }) => ({
      id,
      rule,
      severity,
      kind: isCoverageRule(rule) ? "coverage" : "change",
      title,
      summary,
    }),
  );
  const changes = findings.filter((finding) => finding.kind === "change");
  return {
    verdict: report.verdict,
    changes: {
      count: changes.length,
      highest:
        changes.length > 0
          ? maxSeverity(changes.map((finding) => finding.severity))
          : null,
    },
    findings,
    coverage: {
      old: report.components.flatMap(
        (component) => component.coverage?.left?.gaps ?? [],
      ),
      new: report.components.flatMap(
        (component) => component.coverage?.right?.gaps ?? [],
      ),
    },
    evidence: report.components.flatMap((component) =>
      ["left", "right"].flatMap((side) =>
        component[side]?.application
          ? [
              {
                component: component.name,
                side: side === "left" ? "old" : "new",
                evidence_id: component[side].application.evidence_id,
                root_sha256: component[side].application.root_sha256,
              },
            ]
          : [],
      ),
    ),
    run: {
      elapsed_ms: report.run?.elapsed_ms ?? null,
      depth: report.run?.analysis?.depth ?? null,
      rea_calls: report.run?.rea_calls?.length ?? 0,
    },
  };
};

// The release a package's latest one is compared with, and why that one:
// the release last seen; on first sight the stable release as of `since`,
// else the release before it when `backfill` asks. Null with nothing to
// compare.
const baseOf = (facts, seen, { since, backfill }) => {
  if (seen)
    return seen.latest === facts.latest
      ? null
      : {
          version: seen.latest,
          basis: "the release last seen",
          integrity: seen.integrity,
        };
  if (since) {
    const version = stableAsOf(facts.versions, since, facts.latest);
    return version === null || version === facts.latest
      ? null
      : {
          version,
          basis: `the stable release as of ${since}`,
          integrity: null,
        };
  }
  const version = backfill ? predecessorOf(facts.versions, facts.latest) : null;
  return version === null
    ? null
    : { version, basis: "the release before it", integrity: null };
};

const publishedOf = (facts, version) =>
  facts.versions.find((entry) => entry.version === version)?.published ?? null;

// Fetches both releases, compares them and returns what the entry adds to
// its head: a summary with status "compared", or status "failed" with why.
const compared = async (name, base, latest, context) => {
  const { work, npm, maxUnpackedBytes, heapMb, timeoutMs, depth } = context;
  const packages = path.join(work, "packages");
  const fetched = [];
  for (const pkg of [
    { name, version: base.version, integrity: base.integrity },
    { name, version: latest.version, integrity: latest.integrity },
  ]) {
    const result = await fetchPackage(pkg, packages, {
      ...npm,
      maxBytes: maxUnpackedBytes,
    });
    if (!result.ok) {
      // Nothing is compared: the release already unpacked is not kept.
      for (const dir of fetched) rmSync(dir, { recursive: true, force: true });
      return {
        status: "failed",
        reason: result.reason,
        detail: `${pkg.version}: ${result.detail}`,
      };
    }
    fetched.push(result.dir);
  }
  const report = path.join(
    "reports",
    slugOf(name),
    `${base.version}_${latest.version}`,
  );
  const result = await compareReleases({
    oldDir: fetched[0],
    newDir: fetched[1],
    out: path.join(work, report),
    heapMb,
    timeoutMs,
    depth,
  });
  // The old release is not read again; the new one is the next old one.
  rmSync(fetched[0], { recursive: true, force: true });
  if (!result.ok)
    return { status: "failed", reason: result.reason, detail: result.detail };
  return {
    status: "compared",
    report,
    evidence_kept: true,
    ...summaryOf(result.report),
  };
};

// Checks one package and returns `{ name, outcome }`, with the entry it
// wrote for "compared" and "failed": "unchanged", "baseline" (first seen,
// nothing to compare), or "unreachable" with a reason when the registry
// did not answer, which leaves the package's state as it was.
const check = async (name, context) => {
  const { state, work, npm, now } = context;
  const unreachable = ({ reason, detail }) => ({
    name,
    outcome: "unreachable",
    reason,
    detail,
  });
  const facts = await packageFacts(name, npm);
  if (!facts.ok) return unreachable(facts);
  const seen = state.packages[name];
  const base = baseOf(facts, seen, context);
  const record = (extra) => {
    state.packages[name] = {
      ...seen,
      latest: facts.latest,
      checked_at: now(),
      ...extra,
    };
    writeState(work, state);
  };
  if (seen && base === null) {
    record({});
    return { name, outcome: "unchanged" };
  }
  const latestFacts = await versionFacts(name, facts.latest, npm);
  if (!latestFacts.ok) return unreachable(latestFacts);
  const latest = {
    version: facts.latest,
    published: publishedOf(facts, facts.latest),
    integrity: latestFacts.integrity,
    license: latestFacts.license,
  };
  const seenNow = { integrity: latest.integrity, published: latest.published };
  if (base === null) {
    record(seenNow);
    return { name, outcome: "baseline" };
  }
  if (base.integrity === null) {
    const baseFacts = await versionFacts(name, base.version, npm);
    if (!baseFacts.ok && TRANSIENT.has(baseFacts.reason))
      return unreachable(baseFacts);
    base.integrity = baseFacts.ok ? baseFacts.integrity : null;
  }
  const outcome =
    base.integrity === null
      ? {
          status: "failed",
          reason: "not-found",
          detail: `${base.version}: the registry no longer has it`,
        }
      : await compared(name, base, latest, context);
  if (outcome.status === "failed" && TRANSIENT.has(outcome.reason))
    return unreachable(outcome);
  const entry = {
    schema: SCHEMA,
    id: `${name}@${base.version}..${latest.version}`,
    package: name,
    slug: slugOf(name),
    old: {
      version: base.version,
      published: publishedOf(facts, base.version),
      integrity: base.integrity,
    },
    new: latest,
    basis: base.basis,
    releases_between: releasesBetween(
      facts.versions,
      base.version,
      latest.version,
    ),
    detected_at: now(),
    alert: null,
    ...outcome,
  };
  writeEntry(work, entry);
  record(seenNow);
  return { name, outcome: outcome.status, entry };
};

const sizeOf = (directory) =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce(
      (total, entry) =>
        total +
        statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size,
      0,
    );

/**
 * Removes the Evidence of the oldest entries of the feed in `work` until
 * what is kept fits `maxBytes`, and marks those entries. Their reports and
 * the Evidence ids stay. Returns how many entries lost their Evidence.
 */
export const pruneEvidence = (work, maxBytes) => {
  const kept = readEntries(work)
    .filter((entry) => entry.evidence_kept === true)
    .map((entry) => ({
      entry,
      directory: path.join(work, entry.report, "evidence"),
    }))
    .filter(({ directory }) => existsSync(directory))
    .map((item) => ({ ...item, bytes: sizeOf(item.directory) }))
    .sort((a, b) =>
      String(b.entry.detected_at).localeCompare(String(a.entry.detected_at)),
    );
  let total = 0;
  let pruned = 0;
  for (const { entry, directory, bytes } of kept) {
    total += bytes;
    if (total <= maxBytes) continue;
    rmSync(directory, { recursive: true, force: true });
    writeEntry(work, { ...entry, evidence_kept: false });
    pruned += 1;
  }
  return pruned;
};

/**
 * Checks every package of `watchlist` (names) against the registry, at
 * most `parallel` at a time, and returns one result per package, in the
 * watchlist's order: `{ name, outcome, entry?, reason?, detail? }`.
 * `context` is `{ work, state, npm: { registry }, since, backfill,
 * maxUnpackedBytes, heapMb, timeoutMs, depth, parallel, now, onResult }`; the
 * state is written after each package, and `onResult` hears each result
 * as it comes.
 */
export const runFeed = (watchlist, context) =>
  pool(watchlist, context.parallel, async (name) => {
    const result = await check(name, context).catch((error) => ({
      name,
      outcome: "unreachable",
      reason: "internal-error",
      detail: error.message,
    }));
    context.onResult?.(result);
    return result;
  });
