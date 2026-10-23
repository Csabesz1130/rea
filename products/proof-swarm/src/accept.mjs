// Which answers a swarm run settles. The solvers' reports are not trusted:
// every claim file is checked again here. A review counts only when its
// verdict agrees with the failures it names; one that refutes without
// naming a failure, or upholds while naming one, settles nothing.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { checkClaim } from "./check.mjs";
import { sketch } from "./sketch.mjs";

export const OUTCOMES = [
  "reviewed yes",
  "reviewed no",
  "settled by the scan",
  "undetermined",
  "refuted",
  "review inconsistent",
  "not reviewed",
  "failed the check",
  "no claim",
];

const consistent = (reviews) => {
  if (reviews.length !== 1) return false;
  const [review] = reviews;
  if (!Array.isArray(review?.failures)) return false;
  if (review.verdict === "refuted") return review.failures.length > 0;
  return review.verdict === "upheld" && review.failures.length === 0;
};

/**
 * The outcome of one package an agent worked on: `check` is null when the
 * solver wrote no claim file, and `reviews` are every review that names the
 * package. Only "reviewed yes", "reviewed no" and "undetermined" (a
 * residual the check accepted) are answers; "settled by the scan" is
 * collect's for a package the plan settled before the run.
 */
export const outcomeOf = (claim, check, reviews) => {
  if (check === null) return "no claim";
  if (check.status !== "pass") return "failed the check";
  if (claim.verdict === "undetermined") return "undetermined";
  if (reviews.length === 0) return "not reviewed";
  if (!consistent(reviews)) return "review inconsistent";
  return reviews[0].verdict === "upheld"
    ? `reviewed ${claim.verdict}`
    : "refuted";
};

// The claim a solver wrote and its check, or a null check when there is no
// claim file. A file that is not JSON fails the check with the parse error.
const checked = (file, root) => {
  if (!existsSync(file)) return { claim: null, check: null };
  let claim;
  try {
    claim = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      claim: null,
      check: {
        status: "fail",
        errors: [`the claim file is not JSON: ${error.message}`],
        warnings: [],
      },
    };
  }
  return { claim, check: checkClaim(root, claim) };
};

const byName = (entries) => {
  const map = new Map();
  for (const entry of entries)
    map.set(entry?.name, [...(map.get(entry?.name) ?? []), entry]);
  return map;
};

// A package plan settled before the run, sketched again: its outcome is
// "settled by the scan" only while level 0 still says no.
const settledRecord = (item) => {
  const [head] = sketch(item.dir).levels[0].positions;
  return {
    name: item.name,
    version: item.version,
    batch: null,
    calibration: item.calibration ?? null,
    reasons: item.reasons ?? [],
    claim_file: null,
    claim: null,
    check: null,
    reviews: [],
    solver: null,
    sketch: head,
    outcome: head.verdict === "no" ? "settled by the scan" : "no claim",
  };
};

/**
 * `{ outcomes, records }` for one run: `args` is the workflow's input
 * (`{ claims, batches: [{ id, packages }], settled }`, as plan writes it)
 * and `result` its return value (`{ results: [{ batch, solve, review }] }`).
 * Each record keeps the claim, the check, the reviews and the solver's own
 * report beside the outcome; a package plan settled is sketched again.
 */
export const collect = (args, result) => {
  const runs = Array.isArray(result?.results) ? result.results : [];
  const solved = byName(runs.flatMap((run) => run?.solve?.packages ?? []));
  const reviewed = byName(runs.flatMap((run) => run?.review?.reviews ?? []));
  const records = (args?.batches ?? []).flatMap((batch) =>
    (batch.packages ?? []).map((item) => {
      const file = path.join(args.claims, `${item.slug}.json`);
      const { claim, check } = checked(file, item.dir);
      const reviews = reviewed.get(item.name) ?? [];
      return {
        name: item.name,
        version: item.version,
        batch: batch.id,
        calibration: item.calibration ?? null,
        reasons: item.reasons ?? [],
        claim_file: file,
        claim,
        check,
        reviews,
        solver: solved.get(item.name)?.[0] ?? null,
        outcome: outcomeOf(claim, check, reviews),
      };
    }),
  );
  records.push(...(args?.settled ?? []).map(settledRecord));
  const outcomes = Object.fromEntries(
    OUTCOMES.map((outcome) => [
      outcome,
      records.filter((record) => record.outcome === outcome).length,
    ]),
  );
  return { outcomes, records };
};
