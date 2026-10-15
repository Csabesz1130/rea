// Shared vocabulary for Release Watch rules.
import { isNew } from "../diff.mjs";

export const SEVERITIES = ["info", "low", "medium", "high", "critical"];
export const APP_SOURCE = "REA analyze_javascript_application";
export const CAPTURE_SOURCE = "REA inspect_web_network_capture";

export const severityRank = (severity) => SEVERITIES.indexOf(severity);

export const maxSeverity = (severities) =>
  severities.reduce(
    (highest, severity) =>
      severityRank(severity) > severityRank(highest) ? severity : highest,
    "info",
  );

/** Facts that are new on the right side, with the status that made them new. */
export const newFacts = (items) =>
  items
    .filter(isNew)
    .flatMap((item) =>
      item.right.map((fact) => ({ fact, status: item.status })),
    );

/** How a claim's absence on the left side is known. */
export const absencePhrase = (status, leftLabel) =>
  status === "added"
    ? `absent from ${leftLabel}`
    : `not observed in ${leftLabel}; REA coverage does not establish absence`;

const basisOf = (state) =>
  state === "observed"
    ? "observed"
    : state === "inferred"
      ? "inferred"
      : "unknown";

const where = (fact) => {
  const location = fact?.location ?? null;
  if (location?.record === undefined || location.record === null)
    return location;
  return { ...location, line: null };
};

/**
 * One evidence line: a claim backed by an REA fact. `redact` lists
 * `{ value, with }` pairs: literal values that must never appear in source
 * snippets, and what to show instead.
 */
export const cite = (claim, fact, source, { redact = [] } = {}) => ({
  claim,
  basis: basisOf(fact?.state),
  source,
  location: where(fact),
  artifact_sha256: fact?.artifact_sha256 ?? null,
  rea_authority: fact?.authority ?? null,
  ...(redact.length > 0 ? { redact } : {}),
});

/** One evidence line produced by Release Watch's own correlation. */
export const heuristic = (claim, location = null) => ({
  claim,
  basis: "heuristic",
  source: "Release Watch",
  location,
  artifact_sha256: null,
  rea_authority: null,
});

/** One evidence line for a value REA reported outside a source location. */
export const reported = (claim, basis, source) => ({
  claim,
  basis,
  source,
  location: null,
  artifact_sha256: null,
  rea_authority: null,
});

const before = (a, b) =>
  a.line < b.line || (a.line === b.line && a.column <= b.column);

/** True when source range `inner` lies inside `outer` (both `{ start, end }` with line and column). */
export const within = (inner, outer) =>
  inner !== null &&
  outer !== null &&
  before(outer.start, inner.start) &&
  before(inner.end, outer.end);

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** A URL for display: query values are replaced so keys in query strings never reach a report. */
export const displayUrl = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }
  const names = [...parsed.searchParams.keys()];
  parsed.search = "";
  const base = parsed.toString();
  return names.length === 0
    ? base
    : `${base}?${names.map((name) => `${name}=…`).join("&")}`;
};

export const urlsIn = (text) =>
  typeof text === "string"
    ? (text.match(/(https?|wss?):\/\/[^\s"'`]+/gi) ?? [])
    : [];

export const isVendorHost = (host, vendorDomains) =>
  vendorDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );

/** "the old release's" capture label: `v1.4.0 capture`. */
export const captureLabel = (side) => `${side.label} capture`;

/** Every finding a rule pack returns, plus the facts it has explained. */
export const packResult = (findings = [], claims = {}) => ({
  findings,
  claims: { hosts: claims.hosts ?? [], nodes: claims.nodes ?? [] },
});
