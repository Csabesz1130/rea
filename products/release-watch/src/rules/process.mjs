// Process execution not already explained by a more specific rule, one
// finding per module and method. A key counts when it gained sites or when
// a site's command differs from every old one. A new site that takes a site
// the release lost, with the same method and resolved command, moved; it is
// reported low with the old location. An unresolved command never pairs.
import { movedFrom } from "../moves.mjs";
import {
  contentOrigin,
  copiedSite,
  perComponent,
  processAbsence,
} from "./component-absence.mjs";
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

const siteLine = (fact) =>
  cite(
    `${fact.data.method}() child-process creation${fact.data.command ? "" : " with a command REA did not resolve"}`,
    fact,
    APP_SOURCE,
  );

const finding = (context, group) => {
  const [fact] = group.facts;
  const { method, module } = fact.data;
  const sites = group.facts.map(siteLine);
  const unknowns = group.facts.some((site) => site.data.command === null)
    ? ["REA did not resolve the command statically."]
    : [];
  const moved = movedSites(context, group);
  if (moved)
    return {
      rule: "RW-P01",
      severity: "low",
      title: `Process execution moved: ${method}() now in ${module}`,
      summary: `${context.labels.right} creates child processes from ${module}; ${context.labels.left} ran the same command${moved.length === 1 ? "" : "s"} from ${moved.length === 1 ? "a site" : "sites"} that no longer ${moved.length === 1 ? "has" : "have"} it.`,
      why: "Moved process execution is usually a refactor, but the new location may be reachable from different inputs.",
      recommendation:
        "Check that the moved call takes its command from the same source as before.",
      evidence: [
        ...sites,
        ...moved.map(({ component, fact: old }) => {
          const line = cite(
            component === context.name
              ? `${context.labels.left}: ${method}() with the same command in ${old.data.module}`
              : `${context.releaseLabels?.left ?? context.labels.left}, component ${component}: ${method}() with the same command in ${old.data.module}`,
            old,
            APP_SOURCE,
            { side: "left" },
          );
          return component === context.name
            ? line
            : {
                ...line,
                location: line.location && { ...line.location, component },
              };
        }),
        heuristic(
          "Release Watch pairs each new site with one removed site of the same method and command; REA does not establish that they are the same call",
        ),
      ],
      unknowns,
    };
  const changed = group.status === "changed";
  const absence = processAbsence(context, group);
  if (absence.held) unknowns.push(perComponent("process execution sites"));
  if (absence.copied) unknowns.push(copiedSite(context));
  const gone = context.moves.childProcesses.lost
    .map((site) => site.fact)
    .filter(
      (site) => site.data.method === method && site.data.command === null,
    );
  if (
    !changed &&
    gone.length > 0 &&
    group.facts.every((site) => site.data.command === null)
  )
    unknowns.push(
      `${context.labels.left} had a ${method}() with an unresolved command in ${gone[0].data.module} that is gone now; this may be the same call, moved.`,
    );
  return {
    rule: "RW-P01",
    severity: "high",
    title: changed
      ? `Process execution changed: ${method}() in ${module}`
      : `New process execution: ${method}() in ${module}`,
    summary: changed
      ? `${context.labels.right} runs a different command from ${module} than ${context.labels.left} did.`
      : `${context.labels.right} creates child processes from ${module}${newFileNote(context, module)} (${absence.phrase}).`,
    why: "Process execution is a common step in supply-chain payloads and widens what the app can do on the machine it runs on.",
    recommendation:
      "Confirm the command source and that it cannot be influenced by web content, model output or network data.",
    evidence: [
      ...sites,
      ...(changed
        ? group.left.map((old) =>
            cite(
              `${context.labels.left}: ${method}() ran ${old.data.command ? "a resolved command" : "a command REA did not resolve"}`,
              old,
              APP_SOURCE,
              {
                side: "left",
              },
            ),
          )
        : []),
    ],
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
