// Review of a feed: where each comparison stands for the person who decides
// what gets installed, the decisions people record, and the release of each
// package they last accepted, which is what the next release is compared
// with. "No change found" is not "cleared": a comparison is cleared only
// when REA examined all the code of both releases, and accepted otherwise
// only by a person.
import { appendFileSync } from "node:fs";
import path from "node:path";

import { severityRank } from "../../release-watch/src/rules/shared.mjs";
import { readEntries, writeEntry, writeState } from "./state.mjs";

/** The severities a change can have, least first, for --review-from. */
export const REVIEW_FROM = ["info", "low", "medium", "high", "critical"];

/** True when REA examined only part of the code of a compared release. */
export const examinedInPart = (entry) =>
  entry.status === "compared" &&
  (entry.verdict.errors > 0 ||
    entry.findings.some((finding) => finding.kind === "coverage") ||
    entry.coverage.old.length + entry.coverage.new.length > 0);

/**
 * Where a comparison stands before anyone decides: "not-compared" (the feed
 * could not read it), "needs-review" (a change at or above `reviewFrom`),
 * "not-established" (no such change, but part of the code was not
 * examined, so its absence is not shown) or "cleared" (no such change in
 * code examined in full).
 */
export const standingOf = (entry, reviewFrom) => {
  if (entry.status !== "compared") return "not-compared";
  const floor = severityRank(reviewFrom);
  if (
    entry.findings.some(
      (finding) =>
        finding.kind === "change" && severityRank(finding.severity) >= floor,
    )
  )
    return "needs-review";
  return examinedInPart(entry) ? "not-established" : "cleared";
};

/**
 * Where an entry of a reviewed feed is now: "superseded" when a later
 * comparison of the package replaced it, else a person's verdict
 * ("approved", "rejected"), else its standing. Null for an entry made
 * without review.
 */
export const stateOf = (entry) => {
  if (!entry.review) return null;
  if (entry.review.superseded_by) return "superseded";
  return entry.review.decision?.verdict ?? entry.review.standing;
};

/** True when an entry still waits for a person. */
export const isOpen = (entry) =>
  ["needs-review", "not-established", "not-compared"].includes(stateOf(entry));

const STATE_TEXT = {
  cleared: "cleared: no change found in code examined in full",
  "not-established":
    "not established: no change found, but part of the code was not examined",
  "needs-review": "needs review",
  "not-compared": "needs review: the feed could not compare it",
  superseded: "replaced by a later comparison",
};

/** An entry's review state as one phrase for a page or a feed; null without review. */
export const stateText = (entry) => {
  const state = stateOf(entry);
  if (state === null) return null;
  const decision = entry.review.decision;
  return state === "approved" || state === "rejected"
    ? `${state} by ${decision.by}`
    : STATE_TEXT[state];
};

/**
 * A release as an accepted one, which a package's next release is compared
 * with: `release` is `{ version, integrity, published }`, `basis` says why
 * it counts as accepted.
 */
export const acceptance = (release, basis, at) => ({
  version: release.version,
  integrity: release.integrity,
  published: release.published ?? null,
  basis,
  at,
});

/**
 * The release of a package that counts as accepted: the one recorded, or,
 * for a package watched before review began, the release last seen.
 */
export const acceptedOf = (seen, at) =>
  seen.approved ??
  acceptance(
    {
      version: seen.latest,
      integrity: seen.integrity,
      published: seen.published,
    },
    "the release last seen before review began",
    at,
  );

/**
 * The fields of a package's state that say `release` is accepted: the
 * baseline of what follows, and one more version the gate lets through.
 */
export const acceptedFields = (seen, release) => ({
  approved: release,
  accepted: [...new Set([...(seen?.accepted ?? []), release.version])],
});

/**
 * What review adds when a comparison is recorded: the entry with its
 * standing, and the fields of the package's state, where the accepted
 * release moves to the new one only when the comparison is cleared.
 * `baseline` is the accepted release the entry was compared with.
 */
export const reviewed = (entry, seen, baseline, { from, at }) => {
  const standing = standingOf(entry, from);
  const kept = acceptedFields(seen, baseline);
  return {
    entry: {
      ...entry,
      review: {
        standing,
        review_from: from,
        decision: null,
        superseded_by: null,
      },
    },
    fields:
      standing === "cleared"
        ? acceptedFields(
            kept,
            acceptance(
              entry.new,
              "cleared: no change found in code examined in full",
              at,
            ),
          )
        : kept,
  };
};

/**
 * Marks the earlier comparisons of `entry`'s package that still wait for a
 * person as replaced by it: it starts from the same accepted release and
 * reaches a later one, so deciding on it covers them.
 */
export const supersede = (work, entry) => {
  for (const earlier of readEntries(work))
    if (
      earlier.package === entry.package &&
      earlier.id !== entry.id &&
      isOpen(earlier)
    )
      writeEntry(work, {
        ...earlier,
        review: { ...earlier.review, superseded_by: entry.id },
      });
};

/**
 * Records a person's verdict on the entry `id` of the feed in `work`:
 * `{ ok: true, entry }`, or `{ ok: false, reason }` when no such entry
 * waits for one. An approval makes the entry's new release the accepted
 * one. Each verdict is also a line of decisions.jsonl with the ids and
 * digests of the Evidence it was made on, which nothing rewrites.
 */
export const decide = (work, state, id, { verdict, by, note, at }) => {
  const entry = readEntries(work).find((item) => item.id === id);
  if (!entry) return { ok: false, reason: `no entry has the id ${id}` };
  const now = stateOf(entry);
  if (now === null)
    return { ok: false, reason: `${id} was not recorded in review mode` };
  if (now === "superseded")
    return {
      ok: false,
      reason: `${id} was replaced by ${entry.review.superseded_by}; decide on that one`,
    };
  if (entry.review.decision)
    return {
      ok: false,
      reason: `${id} was already ${now} by ${entry.review.decision.by}`,
    };
  if (now === "cleared")
    return { ok: false, reason: `${id} is cleared and needs no decision` };
  const decision = { verdict, by, at, note: note ?? null };
  const decided = { ...entry, review: { ...entry.review, decision } };
  appendFileSync(
    path.join(work, "decisions.jsonl"),
    `${JSON.stringify({
      id,
      ...decision,
      standing: entry.review.standing,
      old: entry.old,
      new: entry.new,
      evidence: entry.evidence ?? [],
    })}\n`,
  );
  writeEntry(work, decided);
  if (verdict === "approved") {
    const seen = state.packages[entry.package];
    state.packages[entry.package] = {
      ...seen,
      ...acceptedFields(seen, acceptance(entry.new, `approved by ${by}`, at)),
    };
    writeState(work, state);
  }
  return { ok: true, entry: decided };
};

/**
 * Whether `version` of the package `name` may be installed by what the
 * feed's review says: `{ package, version, allowed, state, why }`. Allowed
 * are the releases accepted so far: on first sight, cleared, or approved
 * by a person.
 */
export const gateOf = (state, entries, name, version) => {
  const answer = (allowed, at, why) => ({
    package: name,
    version,
    allowed,
    state: at,
    why,
  });
  const seen = state.packages[name];
  if (!seen)
    return answer(false, "not-watched", "the feed does not watch this package");
  if (seen.approved?.version === version)
    return answer(true, "accepted", seen.approved.basis);
  if (seen.accepted?.includes(version))
    return answer(true, "accepted", "accepted earlier");
  const entry = entries.find(
    (item) =>
      item.package === name &&
      item.new.version === version &&
      stateOf(item) !== null &&
      stateOf(item) !== "superseded",
  );
  return entry
    ? answer(false, stateOf(entry), `${stateText(entry)} (${entry.id})`)
    : answer(
        false,
        "not-reviewed",
        `the feed has not compared this release; the accepted one is ${seen.approved?.version ?? "none"}`,
      );
};
