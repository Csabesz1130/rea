// Which member calls register MCP tools in one app: the one owner of that
// reading, for RW-M01 (which follows them), RW-M02 (which counts them) and
// the report (which lists them). REA reports the calls; which of them
// register tools is Release Watch's correlation. A call counts when the
// app imports an MCP server SDK or framework that registers tools through
// its member (catalog.mjs); a dispatcher call (`setRequestHandler`) only
// when its own first argument reads CallToolRequestSchema, under whatever
// name the module imports it; and a bundled framework's
// `addTool` only where a module that imports a server SDK defines that
// method, as FastMCP bundled into firecrawl-mcp does.
import {
  BUNDLED_REGISTRARS,
  MCP_DISPATCHER,
  MCP_TOOL_CALL,
} from "../catalog.mjs";
import { importedMember, resolveExport } from "../facts/exports.mjs";
import { startsBefore, within } from "../ranges.mjs";
import { mcpServers } from "../surfaces.mjs";
import { heuristic } from "./shared.mjs";

// Methods a framework bundled into a module that imports a server SDK
// defines to register tools.
const bundledRegistrars = (app, servers) => {
  const modules = new Set(
    servers.flatMap((server) => server.facts.map((fact) => fact.data.module)),
  );
  return (app.functions ?? []).filter(
    (fn) =>
      fn.kind === "method" &&
      BUNDLED_REGISTRARS.includes(fn.name) &&
      modules.has(fn.module),
  );
};

/**
 * How one app registers MCP tools: `{ servers, bundled, members }`, the
 * server SDKs and frameworks it imports (surfaces.mjs), the bundled
 * registration methods it defines and every member name that registers
 * tools in it; null when it is not an MCP server.
 */
const registrarsOf = (app) => {
  const servers = app ? mcpServers(app) : [];
  if (servers.length === 0) return null;
  const bundled = bundledRegistrars(app, servers);
  return {
    servers,
    bundled,
    members: new Set([
      ...servers.flatMap((server) => server.registers),
      ...bundled.map((fn) => fn.name),
    ]),
  };
};

// The range of a call's own first argument: the earliest argument REA
// reports at position 0 that starts after the member read the call calls.
// An argument of a call in the receiver (`sessions.get(id).setRequestHandler`)
// lies inside that member read, and one of a call nested in a later
// argument starts after the first argument. When REA reports none, the
// rest of the call after its callee.
const firstArgument = (app, call) => {
  const { module, range, callee } = call.data;
  const after = { start: callee?.end ?? range.start, end: range.end };
  return (
    (app.arguments ?? [])
      .filter(
        (argument) =>
          argument.position === 0 &&
          argument.module === module &&
          within(argument.range, after),
      )
      .sort((a, b) => startsBefore(a.range, b.range))[0]?.range ?? after
  );
};

// The name a binding read refers to, as the module it comes from exports
// it: for an import binding (one REA's import edge with that local name
// declares), the imported name, through export resolution when a local
// module re-exports it (`export { CallToolRequestSchema as CallTool } from
// …`); for any other binding, its own name. A minified
// `import { CallToolRequestSchema as c }` reads c.
const exportedNameOf = (app, read) => {
  const { module, name, binding_range: range } = read.data;
  const entry = app.modules?.get(module);
  const declares = (site) =>
    site.data.local === name && within(range, site.data.range);
  const external = entry?.externalSites.find(declares);
  if (external) return importedMember(external.data);
  const local = entry?.localSites.find(declares);
  if (!local) return name;
  const member = importedMember(local.data);
  if (member === null) return null;
  const found = resolveExport(
    app.modules,
    local.data.module,
    member,
    () => null,
  );
  return found.external
    ? (found.property ?? importedMember(found.external.data))
    : member;
};

// How a dispatcher call's first argument reads CallToolRequestSchema, as
// a claim names it, or null when it does not: a binding that holds that
// export under any local name, or a member read of it
// (`types.CallToolRequestSchema`). A dispatcher registers tools only then.
const toolCallSchema = (app, call) => {
  const { module } = call.data;
  const range = firstArgument(app, call);
  const inside = (item) => item.module === module && within(item.range, range);
  const read = app.bindingReads.find(
    (candidate) =>
      inside(candidate.data) &&
      exportedNameOf(app, candidate) === MCP_TOOL_CALL,
  );
  if (read)
    return read.data.name === MCP_TOOL_CALL
      ? MCP_TOOL_CALL
      : `${read.data.name}, an import of ${MCP_TOOL_CALL}`;
  return (app.members ?? []).some(
    (member) => member.path.at(-1) === MCP_TOOL_CALL && inside(member),
  )
    ? MCP_TOOL_CALL
    : null;
};

// Per app: the calls that register tools, and what each dispatcher's
// first argument reads.
const registered = new WeakMap();

const registrationsOf = (app) => {
  if (!registered.has(app)) {
    const registrars = registrarsOf(app);
    const schemas = new Map();
    const calls = (registrars ? app.memberCalls : []).filter((call) => {
      if (!registrars.members.has(call.data.member)) return false;
      if (call.data.member !== MCP_DISPATCHER) return true;
      const schema = toolCallSchema(app, call);
      if (schema !== null) schemas.set(call.node_id, schema);
      return schema !== null;
    });
    registered.set(app, { calls, schemas });
  }
  return registered.get(app);
};

/** The calls that register MCP tools in one app. */
export const toolRegistrations = (app) =>
  app ? registrationsOf(app).calls : [];

/**
 * What a claim says a registration call is: `registerTool() call`, or for
 * a dispatcher what its first argument reads.
 */
export const registrationClaim = (app, call) => {
  const schema = app ? registrationsOf(app).schemas.get(call.node_id) : null;
  return `${call.data.member}() call${schema ? ` whose first argument reads ${schema}` : ""}`;
};

/** True for a call that dispatches every tool call rather than registering one tool. */
export const isDispatcher = (call) => call.data.member === MCP_DISPATCHER;

/**
 * How a call registers tools: through a CallTool request handler, or per
 * tool, whichever SDK or framework member makes it (`tool()`, `registerTool()`
 * and `addTool()` register alike).
 */
export const registrationApi = (call) =>
  isDispatcher(call) ? "a CallTool request handler" : "per-tool registration";

/** Tool registrations across a release's old and new apps: `{ before, after }`; the release context adds what the totals leave out. */
export const registrationTotals = (leftApps, rightApps) => ({
  before: leftApps.reduce((sum, app) => sum + toolRegistrations(app).length, 0),
  after: rightApps.reduce((sum, app) => sum + toolRegistrations(app).length, 0),
});

/**
 * The tool registrations each side of a member-call diff item holds:
 * `[{ item, before, after }]` for the items with any, whatever REA's order
 * within a module (a setRequestHandler for ListTools does not count).
 */
export const registrationItems = (items, leftApp, rightApp) => {
  const counted = new Set(
    [...toolRegistrations(leftApp), ...toolRegistrations(rightApp)].map(
      (call) => call.node_id,
    ),
  );
  return items
    .map((item) => ({
      item,
      before: item.left.filter((call) => counted.has(call.node_id)),
      after: item.right.filter((call) => counted.has(call.node_id)),
    }))
    .filter(({ before, after }) => before.length + after.length > 0);
};

const names = (list) =>
  list.length === 1
    ? list[0]
    : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

/**
 * The heuristic evidence lines that say why Release Watch treats an app as
 * an MCP server and which calls it counts as tool registrations.
 */
export const serverEvidence = (app) => {
  const registrars = registrarsOf(app);
  if (!registrars) return [];
  const lines = registrars.servers.map(({ label, registers, facts }) => {
    const [imported] = facts;
    const dispatcher = registers.includes(MCP_DISPATCHER)
      ? ` (${MCP_DISPATCHER}() only when its first argument reads ${MCP_TOOL_CALL})`
      : "";
    return heuristic(
      `Release Watch treats this component as an MCP server because ${imported.data.module} imports ${imported.key}, an ${label}, and counts the component's ${names(registers.map((member) => `${member}()`))} calls as tool registrations${dispatcher}`,
      imported.location,
    );
  });
  const [fn] = registrars.bundled;
  if (fn)
    lines.push(
      heuristic(
        `Release Watch also counts ${names([...new Set(registrars.bundled.map((method) => `${method.name}()`))])} calls as tool registrations because ${fn.module}, which imports an MCP server SDK, defines a method ${fn.name}, as a bundled MCP server framework such as FastMCP does; REA does not relate those calls to the SDK`,
        {
          file: fn.module,
          line: fn.range.start.line,
          column: fn.range.start.column,
        },
      ),
    );
  return lines;
};
