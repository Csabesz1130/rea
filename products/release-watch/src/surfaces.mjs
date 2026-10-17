// Which kinds of software a component contains, derived from REA facts.
// Several surfaces can coexist (an Electron app with AI features); each one
// records the facts that establish it.
import {
  aiProviderOf,
  isAiEnvironmentKey,
  packageNameOf,
  sdkOf,
} from "./catalog.mjs";
import { hostOf } from "./urls.mjs";

const reason = (list, text) => {
  list.push(text);
  return list;
};

const specificity = (sdk) =>
  sdk.kind === "mcp-server" ? 2 : sdk.role && sdk.role !== "shared" ? 1 : 0;

/**
 * AI and MCP SDKs one application uses, by package name, with the import and
 * package facts that show each. The one place SDK facts are grouped.
 */
export const sdkUses = (app) => {
  const uses = new Map();
  const add = (fact, imported) => {
    const found = sdkOf(fact.key);
    if (found === null) return;
    // An MCP package is a server when any module imports its server entry;
    // a package installed beside the code serves nothing by itself, and
    // says no more than shared MCP code does.
    const sdk =
      found.kind === "mcp-server" && !imported
        ? { kind: "mcp", label: "MCP SDK", role: "shared" }
        : found;
    const name = packageNameOf(fact.key) ?? fact.key;
    if (!uses.has(name)) uses.set(name, { sdk, facts: [], served: [] });
    const use = uses.get(name);
    // The most specific entry says what the package is: a server entry,
    // then a client or transport entry (`@modelcontextprotocol/sdk/client`),
    // then shared code (`@modelcontextprotocol/sdk/types.js`).
    if (specificity(sdk) > specificity(use.sdk)) use.sdk = sdk;
    if (sdk.kind === "mcp-server") use.served.push(fact);
    use.facts.push(fact);
  };
  for (const fact of app?.imports ?? []) add(fact, true);
  for (const fact of app?.packages ?? []) add(fact, false);
  return uses;
};

/**
 * The MCP server SDKs and frameworks the application's modules import:
 * `[{ name, label, registers, facts }]`, with the member calls each
 * registers tools through and the imports of its server entry.
 */
export const mcpServers = (app) =>
  [...sdkUses(app)]
    .filter(([, use]) => use.sdk.kind === "mcp-server")
    .map(([name, use]) => ({
      name,
      label: use.sdk.label,
      registers: use.sdk.registers,
      facts: use.served,
    }));

/** True when any module of the application imports an MCP server SDK or framework. */
export const isMcpServer = (app) => mcpServers(app).length > 0;

const appSurfaces = (app, surfaces) => {
  if (
    app.ipcHandlers.length + app.bridgeMembers.length + app.windows.length >
    0
  )
    reason(surfaces.electron, "Electron IPC, bridge or window declarations");
  if (app.pageScripts.length > 0 || app.browserModules.size > 0)
    reason(surfaces.web, "HTML pages that load scripts");
  for (const [name, { sdk }] of sdkUses(app))
    reason(
      sdk.kind === "ai" ? surfaces.ai : surfaces.mcp,
      `${sdk.label} (${name})`,
    );
  for (const read of app.configReads)
    if (isAiEnvironmentKey(read.data.key))
      reason(surfaces.ai, `reads ${read.data.key}`);
  const urls = [
    ...app.endpoints.map((fact) => fact.data.value),
    ...app.urlLiterals.map((fact) => fact.data.url),
  ];
  for (const url of urls) {
    const provider = aiProviderOf(hostOf(url));
    if (provider) reason(surfaces.ai, `${provider} URL in code`);
  }
};

const captureSurfaces = (capture, surfaces) => {
  reason(surfaces.web, `runtime capture ${capture.name}`);
  for (const exchange of capture.exchanges) {
    const provider = aiProviderOf(exchange.data.host);
    if (provider) reason(surfaces.ai, `${provider} contacted at runtime`);
  }
};

/** Surfaces of one side of a component: `{ electron, web, ai, mcp }`, each a list of reasons. */
export const surfacesOf = (side) => {
  const surfaces = { electron: [], web: [], ai: [], mcp: [] };
  for (const runtime of side.runtimes ?? [])
    reason(surfaces.electron, `Electron fuse wire in ${runtime.name}`);
  if (side.app) appSurfaces(side.app, surfaces);
  if (side.capture) captureSurfaces(side.capture, surfaces);
  return Object.fromEntries(
    Object.entries(surfaces).map(([name, reasons]) => [
      name,
      [...new Set(reasons)],
    ]),
  );
};

/** Union of both sides' surfaces: the names present on either side. */
export const surfaceNames = (left, right) =>
  ["electron", "web", "ai", "mcp"].filter(
    (name) => left[name].length > 0 || right[name].length > 0,
  );
