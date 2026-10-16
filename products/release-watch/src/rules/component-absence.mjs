// Absence claims for facts rules compare per component: page scripts,
// service workers, direct eval and HTML sinks. A fact another component of
// the old release had is new to this component only, so its claim names the
// component instead of denying what REA saw elsewhere in the old release.
import { oldRelease } from "./network.mjs";
import { absencePhrase } from "./shared.mjs";

// Statuses under which the component's own old side had no fact of a key:
// an old fact with that key then belongs to another component.
const ABSENT = new Set(["added", "not-previously-observed"]);

/** Families whose keys `releaseBaseline` records across the old release. */
export const PER_COMPONENT = [
  "pageScripts",
  "serviceWorkers",
  "dynamicEvaluation",
  "htmlSinks",
];

/** True when another component of the old release had a fact of `family` with this diff key. */
export const heldElsewhere = (context, family, { key, status }) =>
  ABSENT.has(status) && (context.baseline.keys?.[family]?.has(key) ?? false);

/**
 * How a per-component fact's absence from the old side is known: the shared
 * `absencePhrase` unless `held`, else that the component is new, or lacked
 * the fact, while another component of the old release `had` it
 * ("registered it").
 */
export const componentAbsence = (
  context,
  { status, counts = null, held, had },
) => {
  if (!held) return absencePhrase(status, context.labels.left, counts);
  const own = `component ${context.name}`;
  const where =
    context.left.target === null
      ? `${own} is new`
      : `${status === "added" ? "absent from" : "not observed in"} ${own} of ${context.labels.left}`;
  return `${where}; another component of ${oldRelease(context)} ${had}`;
};

/** The unknown a fact another component had carries. */
export const perComponent = (what) =>
  `Release Watch compares ${what} per component, so this may be the same one, moved from or shared with another component.`;
