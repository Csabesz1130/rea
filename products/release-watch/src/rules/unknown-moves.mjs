// The note a finding about sites the release gained carries when one may be
// an old site REA could not see in the new release: that site's file is one
// REA examined there only in part, or its component's new side is one REA
// has no facts for (it failed, or the side gives only a capture or nothing
// REA can analyze), so the site is unknown now (moves.mjs
// unknownCounterparts), not gone, and may be the one that moved.
import { unknownCounterparts } from "../moves.mjs";
import { unseenWords } from "../sides.mjs";
import { componentName, oldLabel } from "./component-absence.mjs";

/**
 * `[note]` when an old site unknown now may be the counterpart of a gained
 * site among `facts`, else `[]`, saying why REA could not see it now.
 * `had(fact)` says what the old site did ("ran exec() with the same
 * command"), and `kind` names what moved.
 */
export const unexaminedNote = (context, moves, facts, { had, kind }) => {
  const matches = unknownCounterparts(moves, facts);
  if (matches.length === 0) return [];
  const [{ component, fact, why }] = matches;
  const more =
    matches.length > 1 ? ` (and ${matches.length - 1} more such sites)` : "";
  const release = context.releaseLabels?.right ?? context.labels.right;
  const name = componentName(context, "right", component);
  const now =
    component === context.id
      ? context.labels.right
      : `component ${name} of ${release}`;
  const lead = `${oldLabel(context, component)} ${had(fact)} in ${fact.data.module}${more}`;
  const moved = `this may be the same ${kind}, moved.`;
  return [
    why === "partial"
      ? `${lead}, which REA could not fully examine in ${now}; ${moved}`
      : `${lead}; ${unseenWords(why, release, name)}, so ${moved}`,
  ];
};
