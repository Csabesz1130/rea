// Absence claims for facts rules compare per component: page scripts,
// service workers, direct eval, HTML sinks, renderer APIs, process sites,
// MCP tool registrations and native helpers. A fact another component of
// the old release had is new to this component only, so its claim names the
// component instead of denying what REA saw elsewhere in the old release.
import { oldRelease } from "./network.mjs";
import { absencePhrase } from "./shared.mjs";

// Statuses under which the component's own old side had no fact of a key:
// an old fact with that key then belongs to another component.
const ABSENT = new Set(["added", "not-previously-observed"]);

const appKeys = (family) => (side) =>
  (side.app?.[family] ?? []).map((fact) => fact.key);

// Each family's keys on one old side: application facts by their diff key,
// helpers by the path pairHelpers pairs them by first.
const PER_COMPONENT = {
  pageScripts: appKeys("pageScripts"),
  serviceWorkers: appKeys("serviceWorkers"),
  dynamicEvaluation: appKeys("dynamicEvaluation"),
  htmlSinks: appKeys("htmlSinks"),
  bridgeMembers: appKeys("bridgeMembers"),
  childProcesses: appKeys("childProcesses"),
  memberCalls: appKeys("memberCalls"),
  helpers: (side) => (side.helpers ?? []).map((helper) => helper.relative),
};

/** The keys of every per-component family across the old release's sides (`baseline.keys`). */
export const releaseKeys = (leftSides) =>
  Object.fromEntries(
    Object.entries(PER_COMPONENT).map(([family, keysOf]) => [
      family,
      new Set(leftSides.flatMap(keysOf)),
    ]),
  );

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

/**
 * How a group of process sites (one module#method key, `newGroups`) was
 * absent from the component's old side: `{ held, phrase }`.
 */
export const processAbsence = (context, group) => {
  const held = heldElsewhere(context, "childProcesses", group);
  const method = group.facts[0]?.data.method;
  return {
    held,
    phrase: componentAbsence(context, {
      ...group,
      held,
      had: `called ${method}() in a module at this path`,
    }),
  };
};

/** The unknown a fact another component had carries. */
export const perComponent = (what) =>
  `Release Watch compares ${what} per component, so this may be the same one, moved from or shared with another component.`;
