// Shared vocabulary for Release Watch rules.
import { isNew } from "../diff.mjs";

export const SEVERITIES = ["info", "low", "medium", "high", "critical"];

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

/** One evidence line: a claim backed by an REA fact. */
export const cite = (claim, fact, source) => ({
  claim,
  basis: basisOf(fact?.state),
  source,
  location: fact?.location ?? null,
  artifact_sha256: fact?.artifact_sha256 ?? null,
  rea_authority: fact?.authority ?? null,
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

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export const urlsIn = (text) =>
  typeof text === "string"
    ? (text.match(/(https?|wss?):\/\/[^\s"'`]+/gi) ?? [])
    : [];

export const isVendorHost = (host, vendorDomains) =>
  vendorDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
