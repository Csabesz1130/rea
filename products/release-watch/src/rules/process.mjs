// Process execution not already explained by a more specific rule, one
// finding per module and method. A key counts when it gained sites or when
// a site's command differs from every old one. When the component has no
// more sites of that method than before and every new command matches one
// that disappeared, the site moved; it is reported low with the old
// locations. An unresolved command never matches a resolved one.
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  newGroups,
  packResult,
} from "./shared.mjs";

const countByMethod = (facts) =>
  facts.reduce(
    (counts, fact) =>
      counts.set(fact.data.method, (counts.get(fact.data.method) ?? 0) + 1),
    new Map(),
  );

// Old-side sites of one method whose key lost them on the new side, in this
// component and, through the release context, in every other component.
const vacated = (context, method) =>
  [
    ...context.diff.app.childProcesses
      .filter((item) => item.left.length > item.right.length)
      .flatMap((item) => item.left.slice(item.right.length)),
    ...(context.release?.vacated.childProcesses
      .filter((fact) => fact.component !== context.name)
      .map((fact) => fact.fact) ?? []),
  ].filter((fact) => fact.data.method === method);

// Site counts of one method before and after, across the release when known.
const counts = (context, method) =>
  context.release?.counts.childProcesses.get(method) ?? {
    before:
      countByMethod(context.left.app?.childProcesses ?? []).get(method) ?? 0,
    after:
      countByMethod(context.right.app?.childProcesses ?? []).get(method) ?? 0,
  };

// Resolved commands pair one to one. An unresolved command never pairs:
// REA could not tell what either call runs.
const commandsMatch = (sites, old) => {
  const remaining = old.map((fact) => fact.data.command).filter(Boolean);
  return sites.every(({ data }) => {
    const index = data.command === null ? -1 : remaining.indexOf(data.command);
    if (index === -1) return false;
    remaining.splice(index, 1);
    return true;
  });
};

const isMove = (context, group, method) => {
  const { before, after } = counts(context, method);
  const old = vacated(context, method);
  return (
    group.status !== "changed" &&
    after <= before &&
    old.length > 0 &&
    commandsMatch(group.facts, old)
  );
};

const newFileNote = (context, modulePath) => {
  const renamed = new Set(
    [...context.aliases.values()].map((alias) => alias.path),
  );
  const before = new Set(
    (context.left.app?.assets ?? []).map((asset) => asset.key),
  );
  return context.left.app && !before.has(modulePath) && !renamed.has(modulePath)
    ? ", a file new in this release"
    : "";
};

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
  if (isMove(context, group, method))
    return {
      rule: "RW-P01",
      severity: "low",
      title: `Process execution moved: ${method}() now in ${module}`,
      summary: `${context.labels.right} creates child processes from ${module}; ${context.labels.left} had as many ${method}() sites with the same commands, in places that no longer have them.`,
      why: "Moved process execution is usually a refactor, but the new location may be reachable from different inputs.",
      recommendation:
        "Check that the moved call takes its command from the same source as before.",
      evidence: [
        ...sites,
        ...vacated(context, method).map((old) =>
          cite(
            `${context.labels.left}: ${method}() in ${old.data.module}`,
            old,
            APP_SOURCE,
            { side: "left" },
          ),
        ),
      ],
      unknowns: [
        ...unknowns,
        "Release Watch pairs the sites by method, command and count; REA does not establish that they are the same call.",
      ],
    };
  const changed = group.status === "changed";
  const gone = vacated(context, method).filter(
    (site) => site.data.command === null,
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
      : `${context.labels.right} creates child processes from ${module}${newFileNote(context, module)} (${absencePhrase(group.status, context.labels.left, group.counts)}).`,
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
