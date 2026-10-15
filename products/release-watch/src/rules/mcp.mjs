// MCP server rules: tools whose handlers start processes, and new tool
// registrations. REA reports the registration call and the process site; it
// does not report tool names, descriptions or schemas. A component is an MCP
// server when any of its modules imports the MCP server SDK; registration
// calls anywhere in it count, since servers often register tools in modules
// that only receive the server object.
import { isMcpServer } from "../surfaces.mjs";
import { reachClaim, reachOf, reachUnknowns, reachedFrom } from "./reach.mjs";
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  heuristic,
  newGroups,
  packResult,
  within,
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
  for (const call of app.memberCalls) {
    const scope = { module: call.data.module, range: call.data.range };
    for (const { exec } of reachedFrom(app, scope).values())
      found.push({
        key: capabilityOf(call, exec),
        call,
        exec,
        path: reachOf(app, scope, exec),
      });
  }
  return found;
};

const countBy = (items) =>
  items.reduce(
    (counts, item) => counts.set(item.key, (counts.get(item.key) ?? 0) + 1),
    new Map(),
  );

/** Connections per capability across a release's old and new apps: `Map(key → { before, after })`. */
export const connectionTotals = (leftApps, rightApps) => {
  const totals = new Map();
  const add = (apps, side) => {
    for (const app of apps)
      for (const [key, count] of countBy(connections(app))) {
        const entry = totals.get(key) ?? { before: 0, after: 0 };
        entry[side] += count;
        totals.set(key, entry);
      }
  };
  add(leftApps, "before");
  add(rightApps, "after");
  return totals;
};

// A connection is new when the component has more connections of that
// capability than before and so does the release: a tool that moved to
// another component keeps the release's count.
const increased = (context, before, after) => (key) => {
  const release = context.release?.connections?.get(key);
  return (
    (after.get(key) ?? 0) > (before.get(key) ?? 0) &&
    (!release || release.after > release.before)
  );
};

const toolExecution = (context) => {
  const { left, right, labels, diff } = context;
  const before = countBy(connections(left.app));
  const pairs = connections(right.app);
  const after = countBy(pairs);
  const isIncreased = increased(context, before, after);
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
  for (const { key, call, exec } of pairs) {
    if (!isIncreased(key) || reported.has(key)) continue;
    reported.add(key);
    // Every registration with this capability: Release Watch cannot tell which one is new.
    const keyed = pairs.filter((pair) => pair.key === key);
    keyed.forEach((pair) => {
      nodes.add(pair.exec.node_id);
      modules.add(pair.call.data.module);
      // Every site of an increased key is explained here, the unchanged one too.
      groups
        .get(pair.exec.key)
        ?.facts.forEach((fact) => nodes.add(fact.node_id));
    });
    findings.push({
      rule: "RW-M01",
      severity: "critical",
      title: `MCP tool can start processes: ${call.data.member}() in ${call.data.module}`,
      summary: `${labels.right} registers an MCP tool whose handler reaches ${exec.data.method}() in ${exec.data.module}.`,
      why: "Any agent connected to this server, and any prompt injection that steers that agent, can ask it to run commands on the host.",
      recommendation:
        "Remove the tool or restrict it to an allow-list of fixed commands, and require human confirmation for each call.",
      evidence: [SERVER, ...connectionEvidence(keyed, groups, labels)],
      unknowns: [
        "REA does not report the tool's name, description or input schema.",
        "REA does not establish that the tool's input reaches the command.",
        ...reachUnknowns(keyed.map((pair) => pair.path)),
      ],
    });
  }
  return { findings, nodes: [...nodes], modules };
};

// Each registration, how it reaches its exec site, and each exec site once.
const connectionEvidence = (keyed, groups, labels) => {
  const cited = new Set();
  return keyed.flatMap(({ call, exec, path }) => {
    const lines = [
      cite(`${call.data.member}() call`, call, APP_SOURCE),
      heuristic(
        reachClaim(path, exec, "the registration call"),
        path.read?.location ?? exec.location,
      ),
    ];
    if (cited.has(exec.node_id)) return lines;
    cited.add(exec.node_id);
    const group = groups.get(exec.key);
    const absence = group
      ? absencePhrase(group.status, labels.left, group.counts)
      : `also in ${labels.left}, where no tool registration reached it`;
    lines.push(
      cite(
        `${exec.data.method}() creates a child process${exec.data.command ? "" : " with a command REA did not resolve"} (${absence})`,
        exec,
        APP_SOURCE,
      ),
    );
    return lines;
  });
};

const DISPATCHER = "setRequestHandler";
const CALL_TOOL = "CallToolRequestSchema";

// A setRequestHandler call registers tools only when it handles CallTool
// requests: it reads CallToolRequestSchema (also as `types.CallToolRequestSchema`).
const registersTools = (app, call) =>
  call.data.member !== DISPATCHER ||
  [
    ...app.bindingReads.map((read) => ({ name: read.data.name, ...read.data })),
    ...(app.members ?? []).map((member) => ({
      ...member,
      name: member.path.at(-1),
    })),
  ].some(
    (read) =>
      read.module === call.data.module &&
      read.name === CALL_TOOL &&
      within(read.range, call.data.range),
  );

/** The calls that register MCP tools in one app. */
export const toolRegistrations = (app) =>
  app && isMcpServer(app)
    ? app.memberCalls.filter((call) => registersTools(app, call))
    : [];

/** Tool registrations across a release's old and new apps: `{ before, after }`. */
export const registrationTotals = (leftApps, rightApps) => ({
  before: leftApps.reduce((sum, app) => sum + toolRegistrations(app).length, 0),
  after: rightApps.reduce((sum, app) => sum + toolRegistrations(app).length, 0),
});

const apisOf = (calls) =>
  new Set(
    calls.map((call) =>
      call.data.member === DISPATCHER
        ? "a CallTool request handler"
        : "per-tool registration",
    ),
  );

// The server moved between one dispatcher and per-tool registration calls,
// so the two counts measure different things.
const apiChange = (context, before, after) => ({
  rule: "RW-M02",
  severity: "low",
  title: "MCP tool registration API changed",
  summary: `${context.labels.left} registered tools through ${[...apisOf(before)].join(" and ")}, ${context.labels.right} through ${[...apisOf(after)].join(" and ")}; Release Watch cannot compare how many tools each has.`,
  why: "New tools can hide in a rewrite of how tools are registered.",
  recommendation: "Compare the tool lists of both releases by hand.",
  evidence: [
    ...after.map((call) =>
      cite(`${call.data.member}() call`, call, APP_SOURCE),
    ),
    SERVER,
  ],
  unknowns: [
    "REA does not report tool names, so Release Watch cannot pair tools across registration APIs.",
  ],
});

/**
 * RW-M02: the server has more tool registration calls than before, once
 * per component, citing the modules that gained calls. Registrations that
 * moved between modules or components keep the totals and are not reported.
 */
const newRegistrations = (context, covered) => {
  if (!isMcpServer(context.right.app)) return [];
  const old = toolRegistrations(context.left.app);
  const now = toolRegistrations(context.right.app);
  const release = context.release?.registrations;
  if (now.length <= old.length || (release && release.after <= release.before))
    return [];
  const apis = [apisOf(old), apisOf(now)].map((set) => [...set].sort().join());
  if (old.length > 0 && apis[0] !== apis[1])
    return [apiChange(context, old, now)];
  const counted = new Set(now.map((call) => call.node_id));
  const gained = context.diff.app.memberCalls.filter(
    (item) =>
      item.right.length > item.left.length &&
      counted.has(item.right[0].node_id) &&
      !covered.has(item.right[0].data.module),
  );
  if (gained.length === 0) return [];
  const added = now.length - old.length;
  return [
    {
      rule: "RW-M02",
      severity: "medium",
      title: `New MCP tool registrations (${old.length} → ${now.length})`,
      summary: `${context.labels.right} makes ${added} more tool registration call${added === 1 ? "" : "s"} than ${context.labels.left}, in ${gained.map((item) => item.right[0].data.module).join(", ")}.`,
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
