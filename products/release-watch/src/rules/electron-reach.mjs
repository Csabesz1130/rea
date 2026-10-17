// RW-E01: renderer-reachable process execution. A renderer API whose IPC
// handler reaches a new, added or changed process site, or, for an API the
// component already exposed, a process site its old handler did not reach
// that runs no command it ran. Each exposure of an API (one preload's
// bridge member) is checked against the handlers that may serve its own
// channel, and one finding per group of process sites (a module and
// method) names every exposure that reaches it. reach.mjs finds the paths;
// this module grades and words them.
import {
  componentAbsence,
  heldElsewhere,
  perComponent,
  processAbsence,
} from "./component-absence.mjs";
import {
  compared,
  handlersOf,
  keptOld,
  keptSummary,
  keptUnknowns,
  oldReach,
  scopeOf,
  servingHandlers,
} from "./electron-kept.mjs";
import { siteUnknowns } from "./process.mjs";
import { reachOf } from "./reach.mjs";
import { reachClaim, reachUnknowns } from "./reach-text.mjs";
import { APP_SOURCE, cite, heuristic, newGroups, reported } from "./shared.mjs";

// The exposures a finding cites in full; the rest it names in one line.
const MAX_CITED = 25;

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

// The old exposures one new exposure of an API the component kept is
// compared with: the old one on its channel; else, for one whose channel no
// new exposure has (a renamed channel) or one whose channel REA did not
// resolve, each such old one (any may be it); else none: an exposure on a
// channel added beside every old one (a new window's preload) is new.
const oldExposures = (item, member) => {
  const { channel } = member.data;
  const same =
    channel === null
      ? []
      : item.left.filter((old) => old.data.channel === channel);
  if (same.length > 0) return same;
  const now = new Set(item.right.map((fact) => fact.data.channel));
  const left = item.left.filter(
    (old) => old.data.channel === null || !now.has(old.data.channel),
  );
  if (left.length > 0) return left;
  return channel === null ? item.left : null;
};

/**
 * The renderer API exposures RW-E01 checks, each `{ member, absence, old
 * }`: every exposure of an API new in the component, and every new one of
 * an API it already exposed (`oldExposures` none), whose every reach is
 * new; and each other exposure of an API it already exposed, whose handler
 * counts only for a site that runs no command its old handlers ran
 * (`compared`: a changed handler, or a helper that now starts a process).
 * `old` is null for a new exposure, else the old handlers that may have
 * served it (`keptOld`).
 */
const rendererApis = (context) => {
  const { left, diff, labels } = context;
  const handlers = handlersOf(left.app);
  const kept = { held: false, phrase: `also in ${labels.left}` };
  const beside = {
    held: false,
    phrase: `${labels.left} exposed this API on other channels only`,
  };
  return diff.app.bridgeMembers.flatMap((item) => {
    if (item.status === "not-compared") return [];
    if (item.left.length === 0) {
      const absence = memberAbsence(context, {
        fact: item.right[0],
        status: item.status,
      });
      return item.right.map((member) => ({ member, absence, old: null }));
    }
    return item.right.map((member) => {
      const old = oldExposures(item, member);
      return old
        ? { member, absence: kept, old: keptOld(left.app, handlers, old) }
        : { member, absence: beside, old: null };
    });
  });
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

// How firmly a use reaches its site: a settled path from the handler for
// the API's channel first, then a new site before one Release Watch is
// unsure of.
const rank = ({ path, compared: how, unsure }) =>
  (path.guess || unsure ? 2 : 0) + (how === "unsure" ? 1 : 0);

// The site of a group an exposure's handler reaches that is not one its
// old handlers reached, with its path and how it compares (`compared`,
// "new" for a new exposure): one a settled path reaches when there is one,
// and a new one before one Release Watch is unsure of; null for none.
const reachedSite = (app, api, scope, group) =>
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
    .sort((a, b) => rank(a) - rank(b))[0] ?? null;

// A use is a guess when its path is, or when the handler is only one that
// may serve the API's channel.
const guessed = (use) => use.path.guess || use.unsure;

// One use's words. A path through a candidate Release Watch could not
// settle names what the handler may reach, so the title and why say may;
// "now" says a kept API's handler newly reaches what it runs.
const useWords = (context, use) => {
  const { api, group, exec } = use;
  const { member, channel } = api.member.data;
  const may = guessed(use);
  const handler = use.unsure
    ? `a ${context.labels.right} handler whose channel REA did not resolve, which may serve it,`
    : "its handler";
  const reach = `${may ? "may reach" : "reaches"} ${exec.data.method}() in ${exec.data.module}`;
  return {
    may,
    now: Boolean(api.old) && use.compared === "new",
    what: `${group.status === "existing" ? "" : "new "}process execution`,
    channel,
    summary:
      api.old && !use.unsure
        ? keptSummary(context.labels, use, reach)
        : `${context.labels.right} exposes ${member}() to web content; ${handler} ${reach}.`,
  };
};

// How the uses after the first reach the group: all through a guess, none,
// or some.
const othersReach = (others) => {
  if (others.every((use) => use.may)) return "may reach";
  return others.some((use) => use.may) ? "reach or may reach" : "reach";
};

const WHY =
  "any script running in the window, including injected content, could ask the main process to start programs with the user's privileges.";

// The finding's title, summary and why: the firmest use's, and how many
// other channels or exposures reach the group.
const findingWords = (context, uses) => {
  const words = uses.map((use) => useWords(context, use));
  const [lead] = words;
  const may = words.every((use) => use.may);
  const now = words.every((use) => use.now) ? "now " : "";
  const channels = [...new Set(words.map((use) => use.channel))];
  const others = channels.length - 1;
  const more =
    others > 0
      ? ` and ${others} other channel${others === 1 ? "" : "s"}`
      : uses.length > 1
        ? ` from ${uses.length} renderer APIs`
        : "";
  const names = uses.slice(1).map(({ api }) => `${api.member.data.member}()`);
  const reach = othersReach(words.slice(1));
  const rest =
    names.length === 0
      ? ""
      : ` ${names.length} other exposure${names.length === 1 ? "" : "s"} of a renderer API ${reach} it as well: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}.`;
  return {
    title: `Renderer ${may ? "may" : "can"} ${now}reach ${lead.what} via "${lead.channel}"${more}`,
    summary: `${lead.summary}${rest}`,
    why: may
      ? `If the handler does reach it, ${WHY}`
      : `${WHY[0].toUpperCase()}${WHY.slice(1)}`,
  };
};

// Each line once: a handler several exposures use, or a path or old-side
// claim several share, is cited once.
const onceEach = () => {
  const cited = new Set();
  return (key, line) => {
    if (cited.has(key)) return [];
    cited.add(key);
    return [line];
  };
};

const at = (location) =>
  `${location?.file}:${location?.line}:${location?.column}`;

// What one use cites: the exposure, its handler, its path and, for a kept
// API, what the old handlers reached.
const useEvidence = (context, use, once) => {
  const { api, handler, exec, path } = use;
  const { member } = api;
  const claim = reachClaim(path, exec, "the handler");
  const where = path.read?.location ?? exec.location;
  const old = api.old ? oldReach(context.labels, api.old, use) : null;
  return [
    cite(
      `Renderer API ${member.data.member} invokes IPC channel "${member.data.channel}" (${api.absence.phrase})`,
      member,
      APP_SOURCE,
    ),
    ...once(
      handler.node_id,
      cite(
        use.unsure
          ? `Main-process handler whose channel REA did not resolve`
          : `Main-process handler for "${member.data.channel}"`,
        handler,
        APP_SOURCE,
      ),
    ),
    ...once(`path\u0000${claim}\u0000${at(where)}`, heuristic(claim, where)),
    ...(old ? once(`old\u0000${old.claim}\u0000${at(old.location)}`, old) : []),
  ];
};

// The exposures past MAX_CITED, named in one line.
const uncitedLine = (uses) =>
  reported(
    `${uses.length} more exposures of renderer APIs reach these sites through their handlers: ${uses.map(({ api }) => `${api.member.data.member} ("${api.member.data.channel}")`).join(", ")}`,
    "derived",
    APP_SOURCE,
  );

// What a use's handler leaves unknown when it is only one that may serve
// the API's channel.
const unsureHandler = (context, { api, handler }) =>
  `Release Watch found no ${context.labels.right} handler for "${api.member.data.channel}"; REA did not resolve the channel of the handler at ${handler.location?.file}:${handler.location?.line}, which may serve ${api.member.data.member}().`;

const groupUnknowns = (context, group, uses, execHeld) => [
  "REA did not establish that the IPC argument reaches the exec command; the path is a correlation of REA facts by location.",
  ...reachUnknowns(uses.map((use) => use.path)),
  ...new Set(
    uses.flatMap((use) => [
      ...(use.api.old ? keptUnknowns(context.labels, use) : []),
      ...(use.unsure ? [unsureHandler(context, use)] : []),
    ]),
  ),
  ...(uses.some((use) => use.api.absence.held)
    ? [perComponent("renderer APIs")]
    : []),
  // What another component or an old site REA could not see may have had
  // of new or changed process sites: what RW-P01 would say of them.
  ...(group.status === "existing"
    ? []
    : siteUnknowns(context, group, execHeld)),
];

const reachFinding = (context, group, uses) => {
  const once = onceEach();
  const execHeld = execAbsence(context, group);
  const evidence = [
    ...uses
      .slice(0, MAX_CITED)
      .flatMap((use) => useEvidence(context, use, once)),
    ...(uses.length > MAX_CITED ? [uncitedLine(uses.slice(MAX_CITED))] : []),
    ...execEvidence(group, execHeld),
  ];
  if (context.right.app.summary?.sender_validation_observations === 0)
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
    ...findingWords(context, uses),
    recommendation:
      "Ask the vendor why a renderer-exposed IPC channel can start processes, and require an allow-list of commands plus sender validation before deployment.",
    evidence,
    unknowns: groupUnknowns(context, group, uses, execHeld),
  };
};

/**
 * RW-E01: renderer API exposures whose IPC handler reaches a new, added
 * or changed process-execution site, or newly reaches any
 * (`rendererApis`): one finding per exec key, naming every exposure that
 * reaches it and citing every site of that key.
 */
export const rendererProcessExecution = (context) => {
  const app = context.right.app;
  const findings = [];
  const coveredExec = new Set();
  const coveredMembers = new Set();
  if (!app) return { findings, coveredExec, coveredMembers };
  const handlers = handlersOf(app);
  const apis = rendererApis(context);
  const invoked = new Set(
    apis.map(({ member }) => member.data.channel).filter((ch) => ch !== null),
  );
  const served = apis
    .flatMap((api) =>
      servingHandlers(handlers, api.member, invoked).map((serving) => ({
        api,
        ...serving,
        scope: scopeOf(serving.handler),
      })),
    )
    .filter(({ scope }) => scope.module !== null && scope.range !== null);
  for (const group of execGroups(context.diff)) {
    const uses = served
      .flatMap(({ api, handler, unsure, scope }) => {
        const site = reachedSite(app, api, scope, group);
        return site ? [{ ...site, api, handler, unsure, group }] : [];
      })
      .sort((a, b) => rank(a) - rank(b));
    if (uses.length === 0) continue;
    group.facts.forEach((fact) => coveredExec.add(fact.node_id));
    group.left.forEach((fact) => coveredExec.add(fact.node_id));
    uses.forEach(({ api }) => coveredMembers.add(api.member.key));
    findings.push(reachFinding(context, group, uses));
  }
  return { findings, coveredExec, coveredMembers };
};
