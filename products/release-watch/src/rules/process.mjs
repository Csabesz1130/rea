// Process execution not already explained by a more specific rule, one
// finding per module and method. A key counts when it gained sites or when
// a site's command differs from every old one. A new site that takes a site
// the release lost, with the same method and resolved command, moved; it is
// reported low with the old location. An unresolved command never pairs,
// and what a changed key's commands are called is process-commands.mjs's.
import { movedFrom } from "../moves.mjs";
import {
  componentName,
  contentOrigin,
  copiedSite,
  oldLabel,
  perComponent,
  processAbsence,
  relocatedUnresolved,
} from "./component-absence.mjs";
import { changedClaims, commandText, unresolved } from "./process-commands.mjs";
import { unexaminedNote } from "./unknown-moves.mjs";
import {
  APP_SOURCE,
  cite,
  heuristic,
  newGroups,
  packResult,
} from "./shared.mjs";

// The lost sites a group's new sites took, across the release; null when
// any new site took none. A changed command at the same site is never a move.
const movedSites = (context, group) =>
  group.status === "changed"
    ? null
    : movedFrom(context.moves.childProcesses, group.facts);

// A file the component's old side did not have is new in the release
// unless the old release shipped its content, which the absence claim says.
const newFileNote = (context, modulePath) =>
  context.left.app && contentOrigin(context, modulePath) === "new"
    ? ", a file new in this release"
    : "";

// What a site runs, naming the command REA resolved when `named`.
const runs = (fact, named) => {
  if (unresolved(fact)) return " with a command REA did not resolve";
  return named ? ` running ${commandText(fact.data.command)}` : "";
};

const siteLine = (fact, named = false) =>
  cite(
    `${fact.data.method}() child-process creation${runs(fact, named)}`,
    fact,
    APP_SOURCE,
  );

const WHY =
  "Process execution is a common step in supply-chain payloads and widens what the app can do on the machine it runs on.";
const RECOMMENDATION =
  "Confirm the command source and that it cannot be influenced by web content, model output or network data.";

// `component` is the identity of the old site's component; its location
// names that component as the old release did.
const movedLine = (context, method, { component, fact: old }) => {
  const line = cite(
    `${oldLabel(context, component)}: ${method}() with the same command in ${old.data.module}`,
    old,
    APP_SOURCE,
    { side: "left" },
  );
  return component === context.id
    ? line
    : {
        ...line,
        location: line.location && {
          ...line.location,
          component: componentName(context, "left", component),
        },
      };
};

const movedFinding = (context, group, moved, unknowns) => {
  const { method, module } = group.facts[0].data;
  return {
    rule: "RW-P01",
    severity: "low",
    title: `Process execution moved: ${method}() now in ${module}`,
    summary: `${context.labels.right} creates child processes from ${module}; ${context.labels.left} ran the same command${moved.length === 1 ? "" : "s"} from ${moved.length === 1 ? "a site" : "sites"} that no longer ${moved.length === 1 ? "has" : "have"} it.`,
    why: "Moved process execution is usually a refactor, but the new location may be reachable from different inputs.",
    recommendation:
      "Check that the moved call takes its command from the same source as before.",
    evidence: [
      ...group.facts.map((fact) => siteLine(fact)),
      ...moved.map((site) => movedLine(context, method, site)),
      heuristic(
        "Release Watch pairs each new site with one removed site of the same method and command; REA does not establish that they are the same call",
      ),
    ],
    unknowns,
  };
};

// What an old site REA could not see in the new release ran, for the note
// that a new site may be that call, moved (unknown-moves.mjs).
const UNEXAMINED = {
  kind: "call",
  had: (fact) =>
    `ran ${fact.data.method}() with ${unresolved(fact) ? "a command REA did not resolve" : "the same command"}`,
};

// A new site with an unresolved command next to one the release lost
// (component-absence.mjs relocatedUnresolved, which RW-M01 shares).
const goneNote = (context, group) => {
  const note = relocatedUnresolved(context, group.facts[0].data.method);
  return group.status !== "changed" && note && group.facts.every(unresolved)
    ? [note]
    : [];
};

const changedFinding = (context, group, unknowns) => {
  const { method, module } = group.facts[0].data;
  const claims = changedClaims(context, group);
  return {
    rule: "RW-P01",
    severity: "high",
    title: `Process execution changed: ${method}() in ${module}`,
    summary: claims.summary,
    why: WHY,
    recommendation: RECOMMENDATION,
    evidence: [
      ...group.facts.map((fact) => siteLine(fact, true)),
      ...group.left.map((old) =>
        cite(
          `${context.labels.left}: ${method}() ran ${unresolved(old) ? "a command REA did not resolve" : commandText(old.data.command)}`,
          old,
          APP_SOURCE,
          { side: "left" },
        ),
      ),
    ],
    unknowns: [...unknowns, ...claims.unknowns],
  };
};

/**
 * What the old release may have had of a group of new or changed process
 * sites (newGroups) that no lost site took: the same site in another
 * component or a copied file, an unresolved site the release lost, or an
 * old site REA could not see now. RW-E01 carries the same unknowns for the
 * sites it claims from RW-P01. `absence` is processAbsence's.
 */
export const siteUnknowns = (
  context,
  group,
  absence = processAbsence(context, group),
) => [
  ...(absence.held ? [perComponent("process execution sites")] : []),
  ...(absence.copied ? [copiedSite(context)] : []),
  ...goneNote(context, group),
  ...unexaminedNote(
    context,
    context.moves.childProcesses,
    group.facts,
    UNEXAMINED,
  ),
];

const finding = (context, group) => {
  const unknowns = group.facts.some(unresolved)
    ? ["REA did not resolve the command statically."]
    : [];
  const moved = movedSites(context, group);
  if (moved) return movedFinding(context, group, moved, unknowns);
  const absence = processAbsence(context, group);
  unknowns.push(...siteUnknowns(context, group, absence));
  if (group.status === "changed")
    return changedFinding(context, group, unknowns);
  const { method, module } = group.facts[0].data;
  return {
    rule: "RW-P01",
    severity: "high",
    title: `New process execution: ${method}() in ${module}`,
    summary: `${context.labels.right} creates child processes from ${module}${newFileNote(context, module)} (${absence.phrase}).`,
    why: WHY,
    recommendation: RECOMMENDATION,
    evidence: group.facts.map((fact) => siteLine(fact)),
    unknowns,
  };
};

export const processPack = (context) =>
  packResult(
    newGroups(context.diff.app.childProcesses, { field: "command" })
      .map((group) => ({
        ...group,
        facts: group.facts.filter(
          (fact) => !context.claimed.nodes.has(fact.node_id),
        ),
      }))
      .filter((group) => group.facts.length > 0)
      .map((group) => finding(context, group)),
  );
