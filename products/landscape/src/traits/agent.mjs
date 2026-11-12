// Agent-tool traits of one component: whether it serves MCP tools or
// connects to MCP servers, and whether a tool reaches process execution.
// Which calls register tools and what they reach is Release Watch's reading
// (mcp-registrations.mjs, reach.mjs); REA reports the calls and the process
// sites, not tool names or schemas.
import { factLine, readingLine } from "../evidence.mjs";
import {
  bundledToolDispatchers,
  mcpServers,
  processLibraryOf,
  registrationClaim,
  sdkUses,
  toolConnections,
  toolRegistrations,
} from "../release-watch.mjs";
import { TRAITS } from "./definitions.mjs";
import {
  inProduct,
  isRuntimeImport,
  productFacts,
  runtimeImports,
} from "./runtime.mjs";

const MAX_LINES = 6;

const at = (fact) =>
  fact.location
    ? `${fact.location.file}:${fact.location.line ?? "?"}`
    : "an unknown place";

const servers = (part, set) => {
  const running = isRuntimeImport(part.app);
  const found = mcpServers(part.app)
    .map((server) => ({ ...server, facts: server.facts.filter(running) }))
    .filter((server) => server.facts.length > 0);
  if (found.length === 0) return false;
  const calls = toolRegistrations(part.app);
  set.add(TRAITS.mcpServer, {
    evidence: [
      ...found.map(({ label, facts: [fact] }) =>
        factLine(
          part.name,
          `${fact.data.module} imports ${fact.key}, an ${label}`,
          fact,
        ),
      ),
      readingLine(
        part.name,
        `Release Watch counts ${calls.length} tool registration call${calls.length === 1 ? "" : "s"}`,
        null,
        "Release Watch",
      ),
    ],
    values: found.map(({ name }) => name),
  });
  return true;
};

const clients = (part, set) => {
  const running = isRuntimeImport(part.app);
  for (const [name, use] of sdkUses(part.app)) {
    if (use.sdk.kind !== "mcp" || use.sdk.role !== "client") continue;
    const fact = use.facts.find(running);
    if (fact)
      set.add(TRAITS.mcpClient, {
        evidence: [
          factLine(
            part.name,
            `${fact.data.module} imports ${fact.key}, an ${use.sdk.label}`,
            fact,
          ),
        ],
        values: [name],
      });
  }
};

const toolProcesses = (part, set) => {
  const connections = toolConnections(part.app).filter(({ call }) =>
    inProduct(call),
  );
  if (connections.length === 0) return;
  const settled = connections.filter((connection) => !connection.path?.guess);
  const cited = (settled.length > 0 ? settled : connections).slice(
    0,
    MAX_LINES,
  );
  set.add(TRAITS.toolProcess, {
    strength: settled.length > 0 ? "yes" : "likely",
    evidence: cited.map(({ call, exec, path }) =>
      readingLine(
        part.name,
        `${registrationClaim(part.app, call)} at ${at(call)} reaches ${exec.data.method}() at ${at(exec)}${path?.guess ? " through a guessed step" : ""}`,
        call.location,
        "Release Watch",
      ),
    ),
    values: [
      ...new Set(connections.map(({ exec }) => `${exec.data.method}()`)),
    ],
  });
};

// Processes a server may start where REA's facts do not show them.
const toolUnknowns = (part, set) => {
  const libraries = [
    ...new Set(
      runtimeImports(part.app)
        .map((fact) => processLibraryOf(fact.key))
        .filter((library) => library !== null),
    ),
  ];
  if (libraries.length > 0)
    set.unknownBecause(
      TRAITS.toolProcess,
      `it imports ${libraries.join(", ")}, which ${libraries.length === 1 ? "starts" : "start"} processes REA does not model`,
    );
  if (productFacts(part.app.processUnknowns).length > 0)
    set.unknownBecause(
      TRAITS.toolProcess,
      "it uses child_process in ways REA did not classify as process calls",
    );
};

// A component that dispatches MCP tool calls with no MCP server SDK import:
// the SDK is bundled into its code, so it likely serves MCP tools, and with
// no import to tell which calls register tools, what they reach is unknown.
const bundledServers = (part, set) => {
  const dispatchers = bundledToolDispatchers(part.app).filter(inProduct);
  if (dispatchers.length === 0) return;
  set.add(TRAITS.mcpServer, {
    strength: "likely",
    evidence: dispatchers
      .slice(0, MAX_LINES)
      .map((call) =>
        factLine(
          part.name,
          `setRequestHandler() call whose first argument reads CallToolRequestSchema, as an MCP server SDK bundled into the code dispatches tool calls; REA reports no import of one`,
          call,
        ),
      ),
  });
  set.unknownBecause(
    TRAITS.toolProcess,
    "its MCP server SDK is bundled into its code, so Release Watch cannot tell which calls register tools",
  );
};

/** Record one component's agent-tool traits. */
export const readAgent = (part, set) => {
  if (!part.app) return;
  clients(part, set);
  if (!servers(part, set)) {
    bundledServers(part, set);
    return;
  }
  toolProcesses(part, set);
  toolUnknowns(part, set);
};
