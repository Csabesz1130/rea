// Which kinds of software a component contains, derived from REA facts.
// Several surfaces can coexist (an Electron app with AI features); each one
// records the facts that establish it.
import { aiProviderOf, isAiEnvironmentKey, sdkOf } from "./catalog.mjs";
import { hostOf } from "./rules/shared.mjs";

const reason = (list, text) => {
  list.push(text);
  return list;
};

const appSurfaces = (app, surfaces) => {
  if (
    app.ipcHandlers.length + app.bridgeMembers.length + app.windows.length >
    0
  )
    reason(surfaces.electron, "Electron IPC, bridge or window declarations");
  if (app.pageScripts.length > 0 || app.browserModules.size > 0)
    reason(surfaces.web, "HTML pages that load scripts");
  for (const fact of [...app.imports, ...app.packages]) {
    const sdk = sdkOf(fact.key);
    if (sdk?.kind === "ai") reason(surfaces.ai, `${sdk.label} (${fact.key})`);
    if (sdk?.kind === "mcp-server" || sdk?.kind === "mcp")
      reason(surfaces.mcp, `${sdk.label} (${fact.key})`);
  }
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
