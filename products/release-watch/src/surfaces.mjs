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

/**
 * AI and MCP SDKs one application uses, by package name, with the import and
 * package facts that show each. The one place SDK facts are grouped.
 */
export const sdkUses = (app) => {
  const uses = new Map();
  for (const fact of [...(app?.imports ?? []), ...(app?.packages ?? [])]) {
    const sdk = sdkOf(fact.key);
    if (sdk === null) continue;
    const name = packageNameOf(fact.key) ?? fact.key;
    if (!uses.has(name)) uses.set(name, { sdk, facts: [] });
    const use = uses.get(name);
    // An MCP package is a server when any module imports its server entry.
    if (sdk.kind === "mcp-server") use.sdk = sdk;
    use.facts.push(fact);
  }
  return uses;
};

/** True when any module of the application imports an MCP server SDK. */
export const isMcpServer = (app) =>
  [...sdkUses(app).values()].some((use) => use.sdk.kind === "mcp-server");

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
  if (side.runtime?.fuses)
    reason(surfaces.electron, `Electron fuse wire in ${side.runtime.name}`);
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
