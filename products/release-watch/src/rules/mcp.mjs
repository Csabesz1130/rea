// MCP server rules: tools whose handlers start processes, and new tool
// registrations. REA reports the registration call and the process site; it
// does not report tool names, descriptions or schemas. A component is an MCP
// server when any of its modules imports the MCP server SDK; registration
// calls anywhere in it count, since servers often register tools in modules
// that only receive the server object.
import { isMcpServer } from "../surfaces.mjs";
import { reachClaim, reachOf } from "./reach.mjs";
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  heuristic,
  newGroups,
  packResult,
} from "./shared.mjs";

const SERVER = heuristic(
  "Release Watch treats this component as an MCP server because one of its modules imports @modelcontextprotocol/sdk/server",
);

// What a registration reaches, independent of the module that holds the
// exec site: moving the exec into a helper module is not a new capability.
const capabilityOf = (call, exec) =>
  `${call.data.member}|${exec.data.method}|${exec.data.command ?? "unresolved"}`;

/** Every registration-to-exec connection one side has. */
const connections = (app) => {
  if (!app || !isMcpServer(app)) return [];
  const found = [];
  for (const call of app.memberCalls)
    for (const exec of app.childProcesses) {
      const path = reachOf(
        app,
        { module: call.data.module, range: call.data.range },
        exec,
      );
      if (path !== null)
        found.push({ key: capabilityOf(call, exec), call, exec, path });
    }
  return found;
};

const countBy = (items) =>
  items.reduce(
    (counts, item) => counts.set(item.key, (counts.get(item.key) ?? 0) + 1),
    new Map(),
  );

// A connection is new when the new side has more connections of that
// capability than the old side.
const toolExecution = (context) => {
  const { left, right, labels, diff } = context;
  const before = countBy(connections(left.app));
  const pairs = connections(right.app);
  const after = countBy(pairs);
  const groups = new Map(
    newGroups(diff.app.childProcesses, { field: "command" }).map((group) => [
      group.key,
      group,
    ]),
  );
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
    const group = groups.get(exec.key);
    // Every site of an increased key is explained here, the unchanged one too.
    group?.facts.forEach((fact) => nodes.add(fact.node_id));
    const execAbsence = group
      ? absencePhrase(group.status, labels.left, group.counts)
      : `also in ${labels.left}, where no tool registration reached a ${exec.data.method}() with this command`;
    findings.push({
      rule: "RW-M01",
      severity: "critical",
      title: `MCP tool can start processes: ${call.data.member}() in ${call.data.module}`,
      summary: `${labels.right} registers an MCP tool whose handler reaches ${exec.data.method}() in ${exec.data.module}.`,
      why: "Any agent connected to this server, and any prompt injection that steers that agent, can ask it to run commands on the host.",
      recommendation:
        "Remove the tool or restrict it to an allow-list of fixed commands, and require human confirmation for each call.",
      evidence: [
        cite(`${call.data.member}() call`, call, APP_SOURCE),
        SERVER,
        heuristic(
          reachClaim(path, exec, "The call"),
          path.read?.location ?? exec.location,
        ),
        cite(
          `${exec.data.method}() creates a child process${exec.data.command ? "" : " with a command REA did not resolve"} (${execAbsence})`,
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

const registrations = (app) => app?.memberCalls.length ?? 0;

/**
 * RW-M02: the server has more registration calls than before, once per
 * component, citing the modules that gained calls. Registrations that moved
 * between modules or APIs keep the total and are not reported.
 */
const newRegistrations = (context, covered) => {
  if (!isMcpServer(context.right.app)) return [];
  const before = registrations(context.left.app);
  const after = registrations(context.right.app);
  if (after <= before) return [];
  const gained = context.diff.app.memberCalls.filter(
    (item) =>
      item.right.length > item.left.length &&
      !covered.has(item.right[0].data.module),
  );
  if (gained.length === 0) return [];
  return [
    {
      rule: "RW-M02",
      severity: "medium",
      title: `New MCP tool registrations (${before} → ${after})`,
      summary: `${context.labels.right} makes ${after - before} more tool registration call${after - before === 1 ? "" : "s"} than ${context.labels.left}, in ${gained.map((item) => item.right[0].data.module).join(", ")}.`,
      why: "Every new tool widens what a connected agent can do.",
      recommendation:
        "Review each new tool's handler and whether it needs human confirmation.",
      evidence: [
        ...gained.flatMap((item) =>
          item.right
            .slice(item.left.length)
            .map((call) =>
              cite(`${call.data.member}() call`, call, APP_SOURCE),
            ),
        ),
        SERVER,
      ],
      unknowns: [
        "REA does not report tool names, so Release Watch counts registration calls across the component.",
      ],
    },
  ];
};

/** MCP rules; claims the exec sites RW-M01 explains so RW-P01 skips them. */
export const mcpPack = (context) => {
  const execution = toolExecution(context);
  return packResult(
    [...execution.findings, ...newRegistrations(context, execution.modules)],
    { nodes: execution.nodes },
  );
};
