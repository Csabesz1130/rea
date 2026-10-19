// What one collected side of a component says about its application code.
// Every rule and release-wide comparison asks these questions here, so a
// side REA has no application facts for is never taken for an empty one.

/**
 * What REA's application facts cover on one collected side: "absent" (the
 * release has no such component), "analyzed", "failed" (REA was given its
 * code and produced no facts), "capture" (the component is given as a
 * capture only, so its code was not provided) or "none" (discovery found
 * nothing REA can analyze).
 */
export const applicationState = (side) => {
  if (side.target === null) return "absent";
  if (side.app) return "analyzed";
  if (side.target.app !== null) return "failed";
  return side.target.kind === "unknown" ? "none" : "capture";
};

/**
 * True when what REA reported is all the side's application code has: the
 * component is absent from the release or REA analyzed it. On any other
 * side, its old sites, tools and windows are unknown, not gone.
 */
export const appKnown = (side) => {
  const state = applicationState(side);
  return state === "absent" || state === "analyzed";
};

/**
 * Why REA's application facts do not describe a side (`appKnown`): its
 * state ("failed", "capture" or "none"), else null.
 */
export const unseenState = (side) =>
  appKnown(side) ? null : applicationState(side);

/**
 * How a claim says side `release` of component `name` has no application
 * facts, for state "failed", "capture" or "none".
 */
export const unseenWords = (state, release, name) =>
  ({
    failed: `REA could not analyze component ${name} of ${release}`,
    capture: `${release} gives only a capture for component ${name}`,
    none: `${release} holds nothing REA can analyze for component ${name}`,
  })[state];

/**
 * True when the side's application was to be analyzed and was not: REA
 * failed on it, or it holds nothing REA can analyze. Its analysis error
 * decides the verdict, so a component whose old side is unanalyzed is
 * graded on coverage only: against nothing, every fact would look new.
 */
export const unanalyzed = (side) => {
  const state = applicationState(side);
  return state === "failed" || state === "none";
};

/** True when one side of a component has an application target and the other has a target without one. */
export const appOneSided = (left, right) =>
  left.target !== null &&
  right.target !== null &&
  (left.target.app === null) !== (right.target.app === null);
