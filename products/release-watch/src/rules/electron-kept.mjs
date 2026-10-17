// RW-E01 for a renderer API a release keeps: which main-process handler
// serves a channel, which old handlers may have served the API (the one
// for its channel, else each whose channel REA did not resolve), what each
// reached as Release Watch connects them, and how a process site the new
// handler reaches compares with that, in words. Unresolved channels and
// commands stay unknown: a site is the same as an old one only when every
// old handler that may have served the API reached it.
import { startsBefore } from "../ranges.mjs";
import { commandText } from "./process-commands.mjs";
import { reachedFrom } from "./reach.mjs";
import { heuristic } from "./shared.mjs";

/** The source range a handler's reach starts from. */
export const scopeOf = (handler) => ({
  module: handler?.location?.file ?? null,
  range: handler?.data.handler_range ?? null,
});

/**
 * One app's main-process handlers: `{ all, byChannel, unresolved }`, by the
 * channel REA resolved, and those whose channel it did not resolve, which
 * serve no channel Release Watch can name.
 */
export const handlersOf = (app) => {
  const all = app?.ipcHandlers ?? [];
  const byChannel = new Map();
  for (const handler of all)
    if (handler.data.channel !== null)
      byChannel.set(handler.data.channel, handler);
  return {
    all,
    byChannel,
    unresolved: all.filter((handler) => handler.data.channel === null),
  };
};

/** The handler of a channel; none for a channel REA did not resolve. */
export const handlerFor = (handlers, channel) =>
  channel === null ? null : (handlers.byChannel.get(channel) ?? null);

/**
 * The handlers of one side that may serve an exposure of a renderer API
 * (`member`): `{ handler, unsure }` for the one for its channel; else, as
 * candidates (`unsure`), each handler whose channel REA did not resolve
 * and, when REA did not resolve the exposure's own channel, each handler
 * whose channel no exposure REA resolved invokes (`invoked`).
 */
export const servingHandlers = (handlers, member, invoked) => {
  const handler = handlerFor(handlers, member.data.channel);
  if (handler) return [{ handler, unsure: false }];
  const candidates =
    member.data.channel === null
      ? handlers.all.filter(
          (other) =>
            other.data.channel === null || !invoked.has(other.data.channel),
        )
      : handlers.unresolved;
  return candidates.map((other) => ({ handler: other, unsure: true }));
};

// What one old handler reaches, as Release Watch connects it (settled or
// guessed): its sites, the method and command of each site whose command
// REA resolved, the methods of every site, and those of the sites whose
// command REA did not resolve.
const reachedBy = (app, handler) => {
  const reached = {
    sites: new Set(),
    commands: new Set(),
    methods: new Set(),
    unresolved: new Set(),
  };
  const scope = scopeOf(handler);
  if (!app || scope.module === null || scope.range === null) return reached;
  for (const { exec } of reachedFrom(app, scope).values()) {
    const { method, command } = exec.data;
    reached.sites.add(exec.node_id);
    reached.methods.add(method);
    if (command === null) reached.unresolved.add(method);
    else reached.commands.add(`${method}|${command}`);
  }
  return reached;
};

// The old handlers one old exposure may have been served by: the one for
// its channel, else each whose channel REA did not resolve, or every one
// when REA did not resolve the exposure's own channel.
const oldCandidates = (handlers, member) => {
  const handler = handlerFor(handlers, member.data.channel);
  if (handler) return [handler];
  return member.data.channel === null ? handlers.all : handlers.unresolved;
};

/**
 * The old side of an API the component kept, for one new exposure of it:
 * `{ member, members, handler, candidates, reached() }`, the old exposures
 * it is compared with (`members`, the first as `member`), the handler for
 * their one channel when there is one, else every handler any of them may
 * have been served by (`oldCandidates`; any may be it), and what each
 * candidate reaches.
 */
export const keptOld = (app, handlers, members) => {
  const [member] = members;
  const handler =
    members.length === 1 ? handlerFor(handlers, member.data.channel) : null;
  const candidates = handler
    ? [handler]
    : [...new Set(members.flatMap((old) => oldCandidates(handlers, old)))];
  let reached = null;
  return {
    member,
    members,
    handler,
    candidates,
    reached: () =>
      (reached ??= candidates.map((candidate) => reachedBy(app, candidate))),
  };
};

// The old site at a new site's place among the sites of a module and method
// the release kept unchanged (as many sites, with the same commands), as
// Release Watch pairs them; null otherwise.
const counterpart = (group, exec) => {
  if (group.status !== "existing") return null;
  const placed = (facts) =>
    facts
      .filter((fact) => fact.data.range)
      .sort((a, b) => startsBefore(a.data.range, b.data.range));
  const [right, left] = [placed(group.facts), placed(group.left)];
  const at = right.indexOf(exec);
  return right.length === left.length && at >= 0 ? left[at] : null;
};

// How a site compares with what one old handler reached: "same" for a
// method and command REA resolved that it reached, or the old site at its
// place (`counterpart`); "unsure" when REA did not resolve this site's
// command and it reached its method, or did not resolve the command of a
// site of its method it reached, so the two may run one program; else
// "new".
const compareWith = (reached, group, exec) => {
  const { method, command } = exec.data;
  if (command !== null && reached.commands.has(`${method}|${command}`))
    return "same";
  if (reached.sites.has(counterpart(group, exec)?.node_id)) return "same";
  const ran = command === null ? reached.methods : reached.unresolved;
  return ran.has(method) ? "unsure" : "new";
};

/**
 * How a site a kept API's handler reaches compares with its old handlers:
 * `{ how, outcomes }`, each candidate's outcome (`compareWith`) and "same"
 * when every one is the same, "new" when every one is new (or there is
 * none), else "unsure".
 */
export const compared = (old, group, exec) => {
  const outcomes = old
    .reached()
    .map((reached) => compareWith(reached, group, exec));
  const all = (how) => outcomes.every((outcome) => outcome === how);
  if (outcomes.length > 0 && all("same")) return { how: "same", outcomes };
  return { how: all("new") ? "new" : "unsure", outcomes };
};

// The old handlers a kept API is compared with, in words.
const oldHandlerWords = (left, old) => {
  const count = old.candidates.length;
  if (old.handler)
    return `the ${left} handler for "${old.member.data.channel}"`;
  const one = count === 1 ? "one" : count;
  const handlers = `main-process handler${count === 1 ? "" : "s"}`;
  if (old.members.length > 1)
    return `the ${one} ${left} ${handlers} its ${old.members.length} ${left} exposures may have invoked`;
  const which = `${handlers}${old.member.data.channel === null ? "" : " whose channel REA did not resolve"}`;
  return `the ${one} ${left} ${which}`;
};

// The method and commands one site's old handlers reached, in words, each
// command as process-commands.mjs shows one.
const ranWords = (old, method) => {
  const commands = new Set();
  let unresolved = false;
  for (const reached of old.reached()) {
    for (const key of reached.commands)
      if (key.startsWith(`${method}|`))
        commands.add(key.slice(method.length + 1));
    unresolved ||= reached.unresolved.has(method);
  }
  return [
    commands.size > 0
      ? `running ${[...commands].map(commandText).join(", ")}`
      : null,
    unresolved ? "at another site whose command REA did not resolve" : null,
  ]
    .filter(Boolean)
    .join(" and ");
};

// The old handlers that may have served the API, by what each reached.
const mixedClaim = (whom, outcomes, { method, command }) => {
  const count = (how) => outcomes.filter((outcome) => outcome === how).length;
  const parts = [
    [
      "same",
      `${method}() ${command ? `running ${commandText(command)}` : "at this site's place"}`,
    ],
    ["unsure", `${method}() at a site whose command REA did not resolve`],
    ["new", `no such site`],
  ]
    .filter(([how]) => count(how) > 0)
    .map(([how, what]) => `${count(how)} to ${what}`);
  return `Of ${whom}, Release Watch connected ${parts.join(", ")}`;
};

// The claim on what the old handlers reached, for a site that is not the
// same as one they reached.
const oldClaim = (whom, old, site) => {
  const { method, command } = site.exec.data;
  if (new Set(site.outcomes).size > 1)
    return mixedClaim(whom, site.outcomes, site.exec.data);
  if (site.compared === "new")
    return `Release Watch connected ${whom} to no ${method}()${command ? ` running ${commandText(command)}` : ""}`;
  return command === null
    ? `Release Watch connected ${whom} to ${method}() ${ranWords(old, method)}; REA did not resolve the command here`
    : `Release Watch connected ${whom} to no ${method}() running ${commandText(command)}, but to ${method}() at a site whose command REA did not resolve`;
};

/** What the old side's handlers reached, for a kept API and the site cited. */
export const oldReach = (labels, old, site) => {
  if (old.candidates.length === 0)
    return heuristic(
      `Release Watch found no ${labels.left} main-process handler for "${old.member.data.channel}", the channel ${old.member.data.member} invoked there`,
      old.member.location,
      { side: "left" },
    );
  return heuristic(
    oldClaim(oldHandlerWords(labels.left, old), old, site),
    (old.handler ?? old.member).location,
    { side: "left" },
  );
};

// Why Release Watch cannot tell whether a site is one the old handler ran.
const unsureWhy = (labels, old, site) => {
  const { method, command } = site.exec.data;
  if (new Set(site.outcomes).size > 1)
    return `it cannot tell which of ${oldHandlerWords(labels.left, old)} served it`;
  return `REA did not resolve ${command === null ? "this site's command" : `the command of ${method}() at a site that handler reached`}`;
};

/** What a kept API's summary says, with `reach` the handler's reach in words. */
export const keptSummary = (labels, { api, ...site }, reach) => {
  const { old } = api;
  const lead = `${labels.right} keeps ${api.member.data.member}() for web content, and its handler`;
  if (site.compared === "unsure")
    return `${lead} ${reach}; Release Watch cannot tell whether that runs a program the ${labels.left} handler ran, since ${unsureWhy(labels, old, site)}.`;
  const { method, command } = site.exec.data;
  const what = `${method}()${command === null ? "" : " with this command"}`;
  const before =
    old.candidates.length === 0
      ? `Release Watch found no ${labels.left} handler for it`
      : `Release Watch connected ${old.handler ? `its ${labels.left} handler` : oldHandlerWords(labels.left, old)} to no ${what}`;
  return `${lead} now ${reach}; ${before}.`;
};

/** What a kept API's comparison leaves unknown. */
export const keptUnknowns = (labels, { api, outcomes }) => {
  const { old } = api;
  return [
    ...(outcomes.includes("unsure")
      ? [
          `REA did not resolve the command of this process site or of one the ${labels.left} handler reached, so this may be a program the handler already ran.`,
        ]
      : []),
    ...(!old.handler && old.candidates.length > 0
      ? [
          `Release Watch found no one ${labels.left} handler by the channel of ${api.member.data.member}(), so it compared with ${oldHandlerWords(labels.left, old)}, ${old.candidates.length === 1 ? "which" : "any of which"} may have served it.`,
        ]
      : []),
  ];
};
