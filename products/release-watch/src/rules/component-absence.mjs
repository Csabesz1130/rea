// Absence claims for facts rules compare per component: page scripts,
// service workers, direct eval, HTML sinks, renderer APIs, process sites,
// MCP tool registrations and native helpers. A fact another component of
// the old release had is new to this component only, so its claim names the
// component instead of denying what REA saw elsewhere in the old release.
import { renamedFrom } from "../diff.mjs";
import { fileDigests, shippedBefore } from "../moves.mjs";
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
 * Where the content of a new side's file was before, by REA's digests:
 * "path" when the component's old side had a file at its path (or one REA
 * paired with it), "component" when that old side shipped the content
 * under another path, "release" when only another component of the old
 * release shipped it, else "new" (also for a file REA reported no digest
 * for).
 */
export const contentOrigin = (context, module) => {
  const own = context.left.app;
  if (
    (own?.assets ?? []).some((asset) => asset.key === module) ||
    renamedFrom(context.aliases)(module) !== undefined
  )
    return "path";
  if (!shippedBefore(context.baseline, context.right.app)(module)) return "new";
  const digest = fileDigests(context.right.app).get(module);
  return [...fileDigests(own).values()].includes(digest)
    ? "component"
    : "release";
};

// A site at a path the component's old side did not have, in a file whose
// content that old side shipped under another path.
const copiedPhrase = (context, status) =>
  `${status === "added" ? "absent from" : "not observed in"} ${context.labels.left} at this path; ${context.labels.left} shipped this file's content under another path`;

/**
 * How a group of process sites (one module#method key, `newGroups`) was
 * absent from the component's old side: `{ held, copied, phrase }`. The
 * old release had it elsewhere when another component had a site at this
 * key, or shipped the content of its file (`held`), or the component's old
 * side shipped that content under another path (`copied`); the claim then
 * says so rather than that the old release lacked it.
 */
export const processAbsence = (context, group) => {
  const atPath = heldElsewhere(context, "childProcesses", group);
  const [fact] = group.facts;
  const origin = ABSENT.has(group.status)
    ? contentOrigin(context, fact?.data.module)
    : "path";
  if (origin === "component" && !atPath)
    return {
      held: false,
      copied: true,
      phrase: copiedPhrase(context, group.status),
    };
  const shipped = origin === "release";
  const held = atPath || shipped;
  const had = [
    atPath ? `called ${fact?.data.method}() in a module at this path` : null,
    shipped ? "shipped this file" : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return {
    held,
    copied: false,
    phrase: componentAbsence(context, { ...group, held, had }),
  };
};

/** The unknown a fact another component had carries. */
export const perComponent = (what) =>
  `Release Watch compares ${what} per component, so this may be the same one, moved from or shared with another component.`;

/** The unknown a process site in a copied file carries. */
export const copiedSite = (context) =>
  `Release Watch compares process sites by module path, so this may be a copy of a site ${context.labels.left} had in a file with the same content.`;
