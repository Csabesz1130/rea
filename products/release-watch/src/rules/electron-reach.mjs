// RW-E01: renderer-reachable process execution. A renderer API whose IPC
// handler reaches a new, added or changed process site, or, for an API the
// component already exposed, a process site its old handler did not reach
// that runs no command it ran. reach.mjs finds the paths; this module
// grades and words them.
import { isNew } from "../diff.mjs";
import {
  componentAbsence,
  heldElsewhere,
  perComponent,
  processAbsence,
} from "./component-absence.mjs";
import {
  compared,
  handlerFor,
  handlersOf,
  keptOld,
  keptSummary,
  keptUnknowns,
  oldReach,
  scopeOf,
} from "./electron-kept.mjs";
import { reachOf } from "./reach.mjs";
import { reachClaim, reachUnknowns } from "./reach-text.mjs";
import {
  APP_SOURCE,
  cite,
  heuristic,
  newFacts,
  newGroups,
  reported,
} from "./shared.mjs";

/**
 * How the component's old side had a renderer API, and whether another old
 * component had what this one did not (`held`).
 */
export const memberAbsence = (context, { fact, status }) => {
  const held = heldElsewhere(context, "bridgeMembers", {
    key: fact.key,
    status,
  });
  return {
    held,
    phrase: componentAbsence(context, {
      status,
      held,
      had: "exposed an API of this name",
    }),
  };
};

const execAbsence = (context, group) =>
  group.status === "existing"
    ? { held: false, phrase: `also in ${context.labels.left}` }
    : processAbsence(context, group);

const execEvidence = (group, absence) =>
  group.facts.map((exec) =>
    cite(
      `${exec.data.method}() creates a child process in ${exec.data.module}${exec.data.command ? "" : " with a command REA did not resolve"} (${absence.phrase})`,
      exec,
      APP_SOURCE,
    ),
  );

const heldUnknowns = (member, exec) => [
  ...(member.held ? [perComponent("renderer APIs")] : []),
  ...(exec.held ? [perComponent("process execution sites")] : []),
];

/**
 * The renderer APIs RW-E01 checks: each new one, whose every reach is new,
 * and each one the component already exposed, whose handler counts only
 * for a site that runs no command its old handlers ran (`compared`: a
 * changed handler, or a helper that now starts a process). Each is `{
 * member, absence, old }`, `old` null for a new API, else the old handlers
 * that may have served it (`keptOld`).
 */
const rendererApis = (context) => {
  const { left, diff } = context;
  const handlers = handlersOf(left.app);
  const kept = diff.app.bridgeMembers
    .filter(
      (item) => !isNew(item) && item.left.length > 0 && item.right.length > 0,
    )
    .map((item) => ({
      member: item.right[0],
      absence: { held: false, phrase: `also in ${context.labels.left}` },
      old: keptOld(left.app, handlers, item.left[0]),
    }));
  return [
    ...newFacts(diff.app.bridgeMembers).map((added) => ({
      member: added.fact,
      absence: memberAbsence(context, added),
      old: null,
    })),
    ...kept,
  ];
};

// New and changed exec sites, then existing ones: a renderer API that newly
// reaches an exec site the old release already had is still new reach.
const execGroups = (diff) => {
  const fresh = newGroups(diff.app.childProcesses, { field: "command" });
  const freshKeys = new Set(fresh.map((group) => group.key));
  return [
    ...fresh,
    ...diff.app.childProcesses
      .filter((item) => item.right.length > 0 && !freshKeys.has(item.key))
      .map((item) => ({
        key: item.key,
        status: "existing",
        counts: { before: item.left.length, after: item.right.length },
        facts: item.right,
        left: item.left,
      })),
  ];
};

// The sites of a group an API's handler reaches that are not ones its old
// handlers reached, each with its path and how it compares (`compared`,
// "new" for a new API): the one cited is a site a settled path reaches when
// there is one, and a new one before one Release Watch is unsure of.
const reachedSites = (app, api, scope, group) => {
  const rank = ({ path, compared: how }) =>
    (path.guess ? 2 : 0) + (how === "unsure" ? 1 : 0);
  return (
    group.facts
      .map((exec) => ({ exec, path: reachOf(app, scope, exec) }))
      .filter(({ path }) => path)
      .map((site) => {
        const found = api.old
          ? compared(api.old, group, site.exec)
          : { how: "new", outcomes: [] };
        return { ...site, compared: found.how, outcomes: found.outcomes };
      })
      .filter((site) => site.compared !== "same")
      .sort((a, b) => rank(a) - rank(b))[0] ?? null
  );
};

// The finding's words. A path through a candidate Release Watch could not
// settle names what the handler may reach, so the title and why say may;
// "now" says the handler newly reaches what it runs.
const reachWords = (context, site) => {
  const { api, group, exec, path } = site;
  const { member, channel } = api.member.data;
  const reach = `${path.guess ? "may reach" : "reaches"} ${exec.data.method}() in ${exec.data.module}`;
  const what = `${group.status === "existing" ? "" : "new "}process execution`;
  const now = api.old && site.compared === "new" ? "now " : "";
  const why =
    "any script running in the window, including injected content, could ask the main process to start programs with the user's privileges.";
  return {
    title: `Renderer ${path.guess ? "may" : "can"} ${now}reach ${what} via "${channel}"`,
    summary: api.old
      ? keptSummary(context.labels, site, reach)
      : `${context.labels.right} exposes ${member}() to web content; its handler ${reach}.`,
    why: path.guess
      ? `If the handler does reach it, ${why}`
      : `${why[0].toUpperCase()}${why.slice(1)}`,
  };
};

const reachFinding = (context, site) => {
  const { app } = context.right;
  const { api, handler, group, exec, path } = site;
  const { member } = api;
  const execHeld = execAbsence(context, group);
  const evidence = [
    cite(
      `Renderer API ${member.data.member} invokes IPC channel "${member.data.channel}" (${api.absence.phrase})`,
      member,
      APP_SOURCE,
    ),
    cite(
      `Main-process handler for "${member.data.channel}"`,
      handler,
      APP_SOURCE,
    ),
    heuristic(
      reachClaim(path, exec, "the handler"),
      path.read?.location ?? exec.location,
    ),
    ...(api.old ? [oldReach(context.labels, api.old, site)] : []),
    ...execEvidence(group, execHeld),
  ];
  if (app.summary?.sender_validation_observations === 0)
    evidence.push(
      reported(
        "REA observed no IPC sender validation in this release",
        "observed",
        APP_SOURCE,
      ),
    );
  return {
    rule: "RW-E01",
    severity: "critical",
    ...reachWords(context, site),
    recommendation:
      "Ask the vendor why a renderer-exposed IPC channel can start processes, and require an allow-list of commands plus sender validation before deployment.",
    evidence,
    unknowns: [
      "REA did not establish that the IPC argument reaches the exec command; the path is a correlation of REA facts by location.",
      ...reachUnknowns([path]),
      ...(api.old ? keptUnknowns(context.labels, site) : []),
      ...heldUnknowns(api.absence, execHeld),
    ],
  };
};

/**
 * RW-E01: a renderer API whose IPC handler reaches a new, added or changed
 * process-execution site, or newly reaches any (`rendererApis`): one
 * finding per channel and exec key, citing every site of that key.
 */
export const rendererProcessExecution = (context) => {
  const app = context.right.app;
  const findings = [];
  const coveredExec = new Set();
  const coveredMembers = new Set();
  if (!app) return { findings, coveredExec, coveredMembers };
  const handlers = handlersOf(app);
  const groups = execGroups(context.diff);
  for (const api of rendererApis(context)) {
    const handler = handlerFor(handlers, api.member.data.channel);
    const scope = scopeOf(handler);
    if (scope.module === null || scope.range === null) continue;
    for (const group of groups) {
      const site = reachedSites(app, api, scope, group);
      if (!site) continue;
      group.facts.forEach((fact) => coveredExec.add(fact.node_id));
      group.left.forEach((fact) => coveredExec.add(fact.node_id));
      coveredMembers.add(api.member.key);
      findings.push(reachFinding(context, { ...site, api, handler, group }));
    }
  }
  return { findings, coveredExec, coveredMembers };
};
