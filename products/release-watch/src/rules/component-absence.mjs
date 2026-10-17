// Absence claims for facts rules compare per component: page scripts,
// service workers, direct eval, HTML sinks, renderer APIs, process sites,
// MCP tool registrations and native helpers. A fact another component of
// the old release had is new to this component only, so its claim names the
// component instead of denying what REA saw elsewhere in the old release;
// nor does a claim deny what an old component REA has no facts for may
// have had, also for facts compared with the whole old release (SDKs,
// packages, shipped original sources). Claims name each side of a renamed
// component by that side's manifest name.
import { renamedFrom } from "../diff.mjs";
import { fileDigests, lostUnresolved, shippedBefore } from "../moves.mjs";
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
 * The manifest name a component has on one side ("left" or "right"), from
 * the release's names by identity: `identity` is a component's identity
 * (`context.id` for this one, `pairComponents`), and a renamed component's
 * claims name the side they are about. A side the release lacks keeps the
 * identity, the other side's manifest name.
 */
export const componentName = (context, side, identity = context.id) =>
  context.release?.names?.get(identity)?.[side] ?? identity;

/**
 * The old release's label for a site of the component whose identity is
 * `component`, naming it as the old release did.
 */
export const oldLabel = (context, component) =>
  component === context.id
    ? context.labels.left
    : `${context.releaseLabels?.left ?? context.labels.left}, component ${componentName(context, "left", component)}`;

/** "component a", "components a and b". */
export const componentList = (names) =>
  `component${names.length === 1 ? "" : "s"} ${names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`;

/**
 * The other components of the old release whose code REA has no facts for
 * (`appKnown`), as a clause, or null: what this component lacked, they may
 * have had.
 */
export const unknownElsewhere = (context) => {
  const own = componentName(context, "left");
  const names = (context.release?.unknown?.left ?? []).filter(
    (name) => name !== own,
  );
  return names.length === 0
    ? null
    : `REA did not analyze the code of ${componentList(names)} of ${oldRelease(context)}`;
};

/**
 * How a per-component fact's absence from the old side is known: the shared
 * `absencePhrase` unless `held` or, for a fact absent from the component's
 * completely covered old side, another component of the old release is
 * unknown; else that the component is new, or lacked the fact, while
 * another component of the old release `had` it ("registered it") or may
 * have had it.
 */
export const componentAbsence = (
  context,
  { status, counts = null, held, had },
) => {
  const unknown = status === "added" ? unknownElsewhere(context) : null;
  if (!held && unknown === null)
    return absencePhrase(status, context.labels.left, counts);
  const where =
    context.left.target === null
      ? `component ${componentName(context, "right")} is new`
      : `${status === "added" ? "absent from" : "not observed in"} component ${componentName(context, "left")} of ${context.labels.left}`;
  return [
    where,
    held ? `another component of ${oldRelease(context)} ${had}` : null,
    unknown === null ? null : `${unknown}, which may have had it`,
  ]
    .filter(Boolean)
    .join("; ");
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
const copiedPhrase = (context, status) => {
  const unknown = status === "added" ? unknownElsewhere(context) : null;
  return `${status === "added" ? "absent from" : "not observed in"} ${context.labels.left} at this path; ${context.labels.left} shipped this file's content under another path${unknown === null ? "" : `; ${unknown}, which may have had it`}`;
};

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

/**
 * The unknown a new process site with a command REA did not resolve carries
 * when the release lost a site of its method with none, or null: such sites
 * never pair as moved, so it may be the same call. The old site is named in
 * its own component (oldLabel).
 */
export const relocatedUnresolved = (context, method) => {
  const [gone] = lostUnresolved(
    context.moves.childProcesses,
    method,
    "command",
  );
  return gone
    ? `${oldLabel(context, gone.component)} had ${/^[aeiou]/i.test(method) ? "an" : "a"} ${method}() with an unresolved command in ${gone.fact.data.module} that is gone now; this may be the same call, moved.`
    : null;
};

/** The unknown a process site in a copied file carries. */
export const copiedSite = (context) =>
  `Release Watch compares process sites by module path, so this may be a copy of a site ${context.labels.left} had in a file with the same content.`;
