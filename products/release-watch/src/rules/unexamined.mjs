// How claims word an old file REA did not fully examine, for the reason
// facts/coverage.mjs unexaminedIn gives, and the node limits a re-run would
// raise for it (limits.mjs keys; none for a file REA could not analyze).
// Every claim about such a file takes its words from here.
const REASONS = {
  ceiling: {
    verb: "reached its per-file node ceiling on",
    limits: ["maxSemanticNodesPerFile"],
  },
  unreached: {
    verb: "gave no semantic facts to",
    limits: ["maxSemanticNodes"],
  },
  failed: { verb: "could not fully analyze", limits: [] },
};

/**
 * What REA did to one or more files for these reasons, as the words after
 * "REA": "reached its per-file node ceiling on", "could not fully analyze
 * or gave no semantic facts to".
 */
export const unexaminedVerb = (reasons) =>
  [...new Set(reasons.map((reason) => REASONS[reason].verb))].join(" or ");

/** The node limits a re-run would raise for a file REA left unexamined for `reason`. */
export const unexaminedLimits = (reason) => REASONS[reason].limits;

/**
 * The clause for REA's global node limit on one side (`label`), after which
 * REA's facts do not say which files it cut short.
 */
export const globalLimitClause = (label) =>
  `REA reached its global node limit on ${label} and may have examined any of its files only in part`;
