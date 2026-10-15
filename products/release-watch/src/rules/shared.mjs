// Shared vocabulary for Release Watch rules.
import { isNew } from "../diff.mjs";

export const SEVERITIES = ["info", "low", "medium", "high", "critical"];
export const APP_SOURCE = "REA analyze_javascript_application";
export const CAPTURE_SOURCE = "REA inspect_web_network_capture";
export const GO_SOURCE = "REA inspect_go_binary";

export const severityRank = (severity) => SEVERITIES.indexOf(severity);

export const maxSeverity = (severities) =>
  severities.reduce(
    (highest, severity) =>
      severityRank(severity) > severityRank(highest) ? severity : highest,
    "info",
  );

/**
 * Facts that are new on the right side, with the status that made them new
 * and, for keys seen on both sides, how many facts each side has.
 */
export const newFacts = (items) =>
  items.filter(isNew).flatMap((item) =>
    item.right.map((fact) => ({
      fact,
      status: item.status,
      counts: { before: item.left.length, after: item.right.length },
    })),
  );

/**
 * New or increased keys, one entry per key with all of its new-side facts,
 * so a rule reports a key once. With `field`, a "changed" key counts too,
 * with only the facts whose value the old side did not have (a command that
 * became dynamic, a new literal command).
 */
export const newGroups = (items, { field = null } = {}) =>
  items.flatMap((item) => {
    const counts = { before: item.left.length, after: item.right.length };
    if (isNew(item))
      return [
        {
          key: item.key,
          status: item.status,
          counts,
          facts: item.right,
          left: item.left,
        },
      ];
    if (field === null || item.status !== "changed") return [];
    const remaining = item.left.map((fact) => fact.data[field]);
    const facts = item.right.filter((fact) => {
      const index = remaining.indexOf(fact.data[field]);
      if (index === -1) return true;
      remaining.splice(index, 1);
      return false;
    });
    return facts.length > 0
      ? [{ key: item.key, status: "changed", counts, facts, left: item.left }]
      : [];
  });

/** How a claim's absence on the left side is known. */
export const absencePhrase = (status, leftLabel, counts = null) => {
  if (status === "added") return `absent from ${leftLabel}`;
  if (status === "changed")
    return counts && counts.before !== counts.after
      ? `${counts.after} sites here, ${counts.before} in ${leftLabel}, with a value ${leftLabel} did not have`
      : `as many sites as ${leftLabel}, with a value ${leftLabel} did not have`;
  if (status === "increased" && counts)
    return `${counts.after} such sites here, ${counts.before} in ${leftLabel}; Release Watch cannot tell which is new`;
  return `not observed in ${leftLabel}; REA coverage does not establish absence`;
};

const basisOf = (state) =>
  state === "observed" || state === "inferred" || state === "derived"
    ? state
    : "unknown";

/** One evidence line: a claim backed by an REA fact, located in the new release unless `side` says otherwise. */
export const cite = (claim, fact, source, { side = "right" } = {}) => ({
  claim,
  basis: basisOf(fact?.state),
  source,
  location: fact?.location ?? null,
  artifact_sha256: fact?.artifact_sha256 ?? null,
  rea_authority: fact?.authority ?? null,
  side,
});

/** One evidence line produced by Release Watch's own correlation or default. */
export const heuristic = (claim, location = null, { side = "right" } = {}) => ({
  claim,
  basis: "heuristic",
  source: "Release Watch",
  location,
  artifact_sha256: null,
  rea_authority: null,
  side,
});

/** One evidence line for a value REA reported outside a source location. */
export const reported = (claim, basis, source) => ({
  claim,
  basis,
  source,
  location: null,
  artifact_sha256: null,
  rea_authority: null,
  side: "right",
});

const before = (a, b) =>
  a.line < b.line || (a.line === b.line && a.column <= b.column);

/** True when source range `inner` lies inside `outer` (both `{ start, end }` with line and column). */
export const within = (inner, outer) =>
  inner !== null &&
  outer !== null &&
  before(outer.start, inner.start) &&
  before(inner.end, outer.end);

export const isVendorHost = (host, vendorDomains) =>
  vendorDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );

/** "v1.4.0 capture". */
export const captureLabel = (side) => `${side.label} capture`;

/** Every finding a rule pack returns, plus the facts it has explained. */
export const packResult = (findings = [], claims = {}) => ({
  findings,
  claims: { hosts: claims.hosts ?? [], nodes: claims.nodes ?? [] },
});
