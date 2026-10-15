// MCP server rules: tools whose handlers start processes, and new tool
// registrations. REA reports the registration call and the process site; it
// does not report tool names, descriptions or schemas.
import { sdkOf } from "../catalog.mjs";
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  heuristic,
  newFacts,
  packResult,
  within,
} from "./shared.mjs";

const isMcpServerModule = (app, modulePath) =>
  [...(app.modules.get(modulePath)?.externalImports ?? [])].some(
    (specifier) => sdkOf(specifier)?.kind === "mcp-server",
  );

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

const toolExecution = (context) => {
  const { right, labels, diff } = context;
  const app = right.app;
  const findings = [];
  const nodes = [];
  const modules = new Set();
  if (!app) return { findings, nodes, modules };
  const calls = app.memberCalls.filter((call) =>
    isMcpServerModule(app, call.data.module),
  );
  for (const { fact: exec, status } of newFacts(diff.app.childProcesses)) {
    for (const call of calls) {
      const path = reach(app, call, exec);
      if (path === null) continue;
      nodes.push(exec.node_id);
      modules.add(call.data.module);
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
            `${call.data.member}() call on an MCP server object`,
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
            `${exec.data.method}() creates a child process (${absencePhrase(status, labels.left)})`,
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
  }
  return { findings, nodes, modules };
};

const newRegistrations = (context, covered) =>
  context.diff.app.memberCalls
    .filter((item) => item.right.length > item.left.length)
    .filter((item) => !covered.has(item.right[0].data.module))
    .filter(
      (item) =>
        context.right.app &&
        isMcpServerModule(context.right.app, item.right[0].data.module),
    )
    .map((item) => {
      const [first] = item.right;
      return {
        rule: "RW-M02",
        severity: "medium",
        title: `New MCP tool registration in ${first.data.module} (${item.left.length} → ${item.right.length})`,
        summary: `${context.labels.right} registers ${item.right.length - item.left.length} more MCP tool${item.right.length - item.left.length === 1 ? "" : "s"} in ${first.data.module}.`,
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

/** MCP rules; claims the exec sites RW-M01 explains so RW-P01 skips them. */
export const mcpPack = (context) => {
  const execution = toolExecution(context);
  return packResult(
    [...execution.findings, ...newRegistrations(context, execution.modules)],
    { nodes: execution.nodes },
  );
};
