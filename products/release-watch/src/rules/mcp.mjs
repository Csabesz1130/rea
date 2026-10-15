// MCP server rules: tools whose handlers start processes, and new tool
// registrations. REA reports the registration call and the process site; it
// does not report tool names, descriptions or schemas. A component is an MCP
// server when any of its modules imports the MCP server SDK; registration
// calls anywhere in it count, since servers often register tools in modules
// that only receive the server object.
import { isMcpServer } from "../surfaces.mjs";
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  heuristic,
  packResult,
  within,
} from "./shared.mjs";

/**
 * How a registration call reaches an exec site: the site lies inside the
 * call (an inline handler), or the call reads a binding imported from the
 * site's module.
 */
const reach = (app, call, exec) => {
  if (
    exec.data.module === call.data.module &&
    within(exec.data.range, call.data.range)
  )
    return { kind: "inline" };
  const imported = app.modules.get(call.data.module)?.imported ?? new Map();
  const read = app.bindingReads.find(
    (candidate) =>
      candidate.data.module === call.data.module &&
      imported.get(candidate.data.name) === exec.data.module &&
      within(candidate.data.range, call.data.range),
  );
  return read ? { kind: "imported", read } : null;
};

/**
 * Every (registration, exec site) pair one side connects, keyed by the
 * registration method and the exec site's key. `execKeys` maps an exec
 * site's node id to its key, so old-side sites are keyed through module
 * aliases like the diff.
 */
const reachablePairs = (app, execKeys) => {
  if (!app || !isMcpServer(app)) return [];
  const pairs = [];
  for (const call of app.memberCalls)
    for (const exec of app.childProcesses) {
      const path = reach(app, call, exec);
      if (path !== null)
        pairs.push({
          key: `${call.data.member}|${execKeys.get(exec.node_id) ?? exec.key}`,
          call,
          exec,
          path,
        });
    }
  return pairs;
};

const countBy = (pairs) =>
  pairs.reduce(
    (counts, pair) => counts.set(pair.key, (counts.get(pair.key) ?? 0) + 1),
    new Map(),
  );

// A pair is new when the new side connects that registration method to that
// exec site more often than the old side did.
const toolExecution = (context) => {
  const { left, right, labels, diff } = context;
  const leftKeys = new Map(
    diff.app.childProcesses.flatMap((item) =>
      item.left.map((fact) => [fact.node_id, item.key]),
    ),
  );
  const statuses = new Map(
    diff.app.childProcesses.map((item) => [item.key, item]),
  );
  const before = countBy(reachablePairs(left.app, leftKeys));
  const pairs = reachablePairs(right.app, new Map());
  const after = countBy(pairs);
  const findings = [];
  const nodes = new Set();
  const modules = new Set();
  const reported = new Set();
  for (const { key, call, exec, path } of pairs) {
    if ((after.get(key) ?? 0) <= (before.get(key) ?? 0) || reported.has(key))
      continue;
    reported.add(key);
    nodes.add(exec.node_id);
    modules.add(call.data.module);
    const item = statuses.get(exec.key);
    const execAbsence =
      item && item.left.length > 0 && item.status !== "increased"
        ? `also in ${labels.left}, where no tool registration reached it`
        : absencePhrase(
            item?.status,
            labels.left,
            item
              ? { before: item.left.length, after: item.right.length }
              : null,
          );
    findings.push({
      rule: "RW-M01",
      severity: "critical",
      title: `MCP tool can start processes: ${call.data.member}() in ${call.data.module}`,
      summary: `${labels.right} registers an MCP tool whose handler reaches ${exec.data.method}() in ${exec.data.module}.`,
      why: "Any agent connected to this server, and any prompt injection that steers that agent, can ask it to run commands on the host.",
      recommendation:
        "Remove the tool or restrict it to an allow-list of fixed commands, and require human confirmation for each call.",
      evidence: [
        cite(
          `${call.data.member}() call in an MCP server component`,
          call,
          APP_SOURCE,
        ),
        path.kind === "inline"
          ? heuristic(
              `${exec.data.method}() lies inside that call's source range, in its handler`,
              exec.location,
            )
          : heuristic(
              `The call reads ${path.read.data.name}, which ${call.data.module} imports from ${exec.data.module}`,
              path.read.location,
            ),
        cite(
          `${exec.data.method}() creates a child process (${execAbsence})`,
          exec,
          APP_SOURCE,
        ),
      ],
      unknowns: [
        "REA does not report the tool's name, description or input schema.",
        "REA does not establish that the tool's input reaches the command.",
      ],
    });
  }
  return { findings, nodes: [...nodes], modules };
};

const newRegistrations = (context, covered) => {
  if (!isMcpServer(context.right.app)) return [];
  return context.diff.app.memberCalls
    .filter((item) => item.right.length > item.left.length)
    .filter((item) => !covered.has(item.right[0].data.module))
    .map((item) => {
      const [first] = item.right;
      const added = item.right.length - item.left.length;
      return {
        rule: "RW-M02",
        severity: "medium",
        title: `New MCP tool registration in ${first.data.module} (${item.left.length} → ${item.right.length})`,
        summary: `${context.labels.right} makes ${added} more ${first.data.member}() call${added === 1 ? "" : "s"} in ${first.data.module}.`,
        why: "Every new tool widens what a connected agent can do.",
        recommendation:
          "Review each new tool's handler and whether it needs human confirmation.",
        evidence: item.right.map((call) =>
          cite(`${call.data.member}() call`, call, APP_SOURCE),
        ),
        unknowns: [
          "REA does not report tool names, so Release Watch counts registration calls.",
        ],
      };
    });
};

/** MCP rules; claims the exec sites RW-M01 explains so RW-P01 skips them. */
export const mcpPack = (context) => {
  const execution = toolExecution(context);
  return packResult(
    [...execution.findings, ...newRegistrations(context, execution.modules)],
    {
      nodes: execution.nodes,
    },
  );
};
