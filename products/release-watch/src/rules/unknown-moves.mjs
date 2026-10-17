// The note a finding about sites the release gained carries when one may be
// an old site REA could not see in the new release: that site's file is one
// REA examined there only in part or not at all, so the site is unknown now
// (moves.mjs unknownCounterparts), not gone, and may be the one that moved.
import { unknownCounterparts } from "../moves.mjs";
import { componentName, oldLabel } from "./component-absence.mjs";

/**
 * `[note]` when an old site unknown now may be the counterpart of a gained
 * site among `facts`, else `[]`. `had(fact)` says what the old site did
 * ("ran exec() with the same command"), and `kind` names what moved.
 */
export const unexaminedNote = (context, moves, facts, { had, kind }) => {
  const matches = unknownCounterparts(moves, facts);
  if (matches.length === 0) return [];
  const [{ component, fact }] = matches;
  const more =
    matches.length > 1 ? ` (and ${matches.length - 1} more such sites)` : "";
  const now =
    component === context.id
      ? context.labels.right
      : `component ${componentName(context, "right", component)} of ${context.releaseLabels?.right ?? context.labels.right}`;
  return [
    `${oldLabel(context, component)} ${had(fact)} in ${fact.data.module}${more}, which REA could not fully examine in ${now}; this may be the same ${kind}, moved.`,
  ];
};
