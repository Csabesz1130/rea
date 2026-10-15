// Process execution not already explained by a more specific rule. Sites are
// grouped by module and method, so a second exec() where one existed is
// reported once, with both counts. When the component has no more sites of
// that method than before and every command is unresolved or already used,
// the site most likely moved; it is reported low, with the old locations.
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  newFacts,
  packResult,
} from "./shared.mjs";

const countByMethod = (facts) =>
  facts.reduce(
    (counts, fact) =>
      counts.set(fact.data.method, (counts.get(fact.data.method) ?? 0) + 1),
    new Map(),
  );

// Old-side sites of one method whose key no longer exists on the new side.
const vacated = (context, method) =>
  context.diff.app.childProcesses
    .filter((item) => item.right.length === 0)
    .flatMap((item) => item.left)
    .filter((fact) => fact.data.method === method);

const isMove = (context, entries, method) => {
  const before = countByMethod(context.left.app?.childProcesses ?? []);
  const after = countByMethod(context.right.app?.childProcesses ?? []);
  const commands = new Set(
    (context.left.app?.childProcesses ?? [])
      .map((fact) => fact.data.command)
      .filter(Boolean),
  );
  return (
    (after.get(method) ?? 0) <= (before.get(method) ?? 0) &&
    vacated(context, method).length > 0 &&
    entries.every(
      ({ fact }) =>
        fact.data.command === null || commands.has(fact.data.command),
    )
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

const finding = (context, entries) => {
  const [{ fact, status, counts }] = entries;
  const { method, module } = fact.data;
  const sites = entries.map((entry) =>
    cite(
      `${entry.fact.data.method}() child-process creation`,
      entry.fact,
      APP_SOURCE,
    ),
  );
  const unknowns = entries.some((entry) => entry.fact.data.command === null)
    ? ["REA did not resolve the command statically."]
    : [];
  if (isMove(context, entries, method))
    return {
      rule: "RW-P01",
      severity: "low",
      title: `Process execution moved: ${method}() now in ${module}`,
      summary: `${context.labels.right} creates child processes from ${module}; ${context.labels.left} had as many ${method}() sites, in places that no longer have one.`,
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
        "Release Watch pairs the sites by method and count; REA does not establish that they are the same call.",
      ],
    };
  return {
    rule: "RW-P01",
    severity: "high",
    title: `New process execution: ${method}() in ${module}`,
    summary: `${context.labels.right} creates child processes from ${module}${newFileNote(context, module)} (${absencePhrase(status, context.labels.left, counts)}).`,
    why: "Process execution is a common step in supply-chain payloads and widens what the app can do on the machine it runs on.",
    recommendation:
      "Confirm the command source and that it cannot be influenced by web content, model output or network data.",
    evidence: sites,
    unknowns,
  };
};

export const processPack = (context) => {
  const groups = new Map();
  for (const entry of newFacts(context.diff.app.childProcesses)) {
    if (context.claimed.nodes.has(entry.fact.node_id)) continue;
    if (!groups.has(entry.fact.key)) groups.set(entry.fact.key, []);
    groups.get(entry.fact.key).push(entry);
  }
  return packResult(
    [...groups.values()].map((entries) => finding(context, entries)),
  );
};
