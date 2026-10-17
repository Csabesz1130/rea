// RW-A01: where a release sends prompts. An AI provider host the old
// release never contacted, or a provider that browser code now calls, may
// call, or reaches through a provider SDK when no old browser code did.
import { aiProviderOf } from "../catalog.mjs";
import { sdkUses } from "../surfaces.mjs";
import {
  browserGuessedHosts,
  browserHosts,
  browserSources,
  isGuess,
} from "./destinations.mjs";
import { sourceEvidence, sourceUnknowns } from "./network-evidence.mjs";
import { absenceUnknowns, hostAbsence, oldRelease } from "./network.mjs";
import { APP_SOURCE, cite, heuristic } from "./shared.mjs";

export const BROWSER_LIMIT =
  "Release Watch classifies browser code by what HTML pages and service workers load; dedicated workers and scripts loaded at runtime are not classified, so the old placement may also have been in the browser.";

export const BROWSER_CODE = heuristic(
  "Release Watch treats scripts an HTML page or service worker loads, and the modules they import, as browser code",
);

/** Every member of the given sets (missing ones are empty), as one set. */
export const union = (...sets) =>
  new Set(sets.flatMap((set) => [...(set ?? [])]));

// Node.js built-ins that do host I/O, which browser bundles do not polyfill;
// any `node:` specifier names a built-in as well.
const HOST_BUILTINS = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "net",
  "os",
  "readline",
  "repl",
  "tls",
  "v8",
  "vm",
  "worker_threads",
]);
const isHostBuiltin = (specifier) =>
  specifier.startsWith("node:") || HOST_BUILTINS.has(specifier);

// True when no HTML page or service worker of the app loads code.
const hasNoPages = (app) =>
  app.browserModules.size === 0 &&
  app.pageScripts.length === 0 &&
  app.serviceWorkers.length === 0 &&
  (app.inlineScripts ?? 0) === 0;

/**
 * Modules of one app Release Watch takes as server code, each with the
 * module and built-in that show it (`{ module, builtin }`): in an app whose
 * code no HTML page or service worker loads, a module that imports a
 * Node.js built-in for host I/O and every module it imports. Release
 * Watch's correlation: REA does not report where code runs.
 */
export const serverModules = (app) => {
  const server = new Map();
  if (!app || !hasNoPages(app)) return server;
  for (const [modulePath, entry] of app.modules) {
    const builtin = [...entry.externalImports].find(isHostBuiltin);
    if (builtin === undefined) continue;
    const pending = [modulePath];
    while (pending.length > 0) {
      const next = pending.pop();
      if (server.has(next)) continue;
      server.set(next, { module: modulePath, builtin });
      pending.push(...(app.modules.get(next)?.local ?? []));
    }
  }
  return server;
};

/** Why Release Watch takes an old carrier of a key as server code, as an evidence claim. */
export const serverLine = (release, { module, via }) =>
  heuristic(
    via.module === module
      ? `Release Watch takes ${module} in ${release} as server code: it imports ${via.builtin}, and no HTML page or service worker of its component loads code`
      : `Release Watch takes ${module} in ${release} as server code: ${via.module} imports ${via.builtin} and, directly or through other modules, ${module}; no HTML page or service worker of its component loads code`,
  );

export const SERVER_LIMIT =
  "Release Watch takes code as server code from its imports; REA does not report where code runs, and another site could still load a script it ships.";

const ROUTE =
  "Route model calls through the vendor's server, and confirm how the browser authenticates.";
const DPA =
  "Confirm the provider is covered by your data processing agreements and the vendor's AI disclosures.";
const browserRisk = (provider) =>
  `A browser cannot authenticate to ${provider} without a credential anyone can read, unless the vendor issues short-lived tokens.`;

// Title, why and recommendation by what REA's facts show: a browser call,
// a URL browser code only holds near requests, or a destination elsewhere,
// observed or guessed.
const WORDING = {
  browser: ({ provider, host }) => ({
    title: `Browser code calls ${provider} directly (${host})`,
    why: `Prompts and user data now go to ${provider} straight from users' browsers. ${browserRisk(provider)}`,
    recommendation: ROUTE,
  }),
  "browser-guess": ({ provider, host }) => ({
    title: `Browser code may call ${provider} directly (${host})`,
    why: `Release Watch did not see this code call ${provider}, only its URL. If it does, prompts and user data go to ${provider} straight from users' browsers. ${browserRisk(provider)}`,
    recommendation: `Confirm whether this browser code calls ${provider}; if it does, ${ROUTE[0].toLowerCase()}${ROUTE.slice(1)}`,
  }),
  guess: ({ provider, host }) => ({
    title: `New AI provider may receive data: ${provider} (${host})`,
    why: `Release Watch did not see a request to ${provider}, only its URL. If the code does send to it, prompts and user data go to a new processor for privacy, contract and AI-governance reviews.`,
    recommendation: `Confirm whether the code sends data to ${provider}; if it does, ${DPA[0].toLowerCase()}${DPA.slice(1)}`,
  }),
  observed: ({ provider, host }) => ({
    title: `New AI provider receives data: ${provider} (${host})`,
    why: `Prompts and user data now go to ${provider}. That is a new processor for privacy, contract and AI-governance reviews.`,
    recommendation: DPA,
  }),
};

const providerSummary = (
  context,
  { provider, host, fresh, guess, browser },
) => {
  const { labels } = context;
  const holds = `holds a URL for ${provider} (${host}) next to requests REA could not resolve or does not model`;
  if (fresh)
    return guess
      ? `${labels.right} ${holds}; ${hostAbsence(context, host)}.`
      : `${labels.right} sends requests to ${provider}; ${hostAbsence(context, host)}.`;
  const before = context.network.known.has(host)
    ? `no module of ${oldRelease(context)} that contacted ${host} was classified that way`
    : `${oldRelease(context)} held a URL for ${host} only in code not classified that way`;
  return browser === "call"
    ? `${labels.right} calls ${provider} from code Release Watch classifies as browser code; ${before}.`
    : `${labels.right} ${holds}, in code Release Watch classifies as browser code; ${before}.`;
};

const providerFinding = (context, facts) => {
  const { fresh, guess, browser, sources } = facts;
  // An observed browser call names the finding; a URL browser code only
  // holds does when it is all that shows the provider or all that is new.
  const mode =
    browser === "call"
      ? "browser"
      : browser === "guess" && (guess || !fresh)
        ? "browser-guess"
        : guess
          ? "guess"
          : "observed";
  const inBrowser = browserSources(context.right, sources);
  return {
    rule: "RW-A01",
    // Only the browser placement is new when the host was known; that
    // placement is Release Watch's classification, so it reviews, not
    // blocks, and so does a destination Release Watch only guessed.
    severity: fresh && !guess ? "high" : "medium",
    ...WORDING[mode](facts),
    summary: providerSummary(context, facts),
    evidence: [
      ...sourceEvidence(sources, context.labels),
      ...(inBrowser.some((source) => source.kind !== "capture")
        ? [BROWSER_CODE]
        : []),
    ],
    unknowns: [
      ...sourceUnknowns(sources),
      "Release Watch does not see what the requests contain.",
      ...(fresh ? absenceUnknowns(context, facts.host) : [BROWSER_LIMIT]),
    ],
  };
};

/** RW-A01 for provider hosts, and the hosts it claims so RW-N01 does not repeat them. */
export const providerFindings = (context) => {
  const { right, network } = context;
  const findings = [];
  const hosts = [];
  // Browser placement anywhere in the old release, so code that moved
  // between components keeps its old classification. A URL old browser
  // code only held near requests is not a call; new browser code that
  // still only holds one is not a new placement either.
  const oldBrowser = union(
    browserHosts(context.left),
    context.baseline.browserHosts,
  );
  const oldGuessed = union(
    browserGuessedHosts(context.left),
    context.baseline.browserGuessed,
  );
  for (const [host, sources] of network.current) {
    const provider = aiProviderOf(host);
    if (provider === null) continue;
    const inBrowser = browserSources(right, sources);
    const browser =
      inBrowser.length === 0 ? null : isGuess(inBrowser) ? "guess" : "call";
    const fresh = network.fresh.has(host);
    const placed =
      browser !== null &&
      !oldBrowser.has(host) &&
      !(browser === "guess" && oldGuessed.has(host));
    if (!fresh && !placed) continue;
    hosts.push(host);
    findings.push(
      providerFinding(context, {
        provider,
        host,
        sources,
        fresh,
        guess: isGuess(sources),
        browser,
      }),
    );
  }
  return { findings, hosts };
};

/** AI SDKs that call one provider's API, imported by one app's browser code, by package name. */
export const browserSdkUses = (app) =>
  new Map(
    [...sdkUses(app)].flatMap(([name, use]) => {
      if (use.sdk.kind !== "ai" || !use.sdk.provider) return [];
      const facts = use.facts.filter((fact) =>
        app.browserModules.has(fact.data.module),
      );
      return facts.length > 0 ? [[name, { ...use, facts }]] : [];
    }),
  );

/**
 * RW-A01 for a provider SDK that browser code imports when no browser code
 * of the old release did: calls through an SDK carry no host for the
 * destination rules to see. `{ findings, sdks }`, with the package names
 * reported.
 */
export const sdkPlacementFindings = (context) => {
  const before = union(
    new Set(browserSdkUses(context.left.app).keys()),
    context.baseline.browserSdks,
  );
  const used = union(
    new Set(sdkUses(context.left.app).keys()),
    context.baseline.sdks,
  );
  const old = oldRelease(context);
  const placed = [...browserSdkUses(context.right.app)].filter(
    ([name]) => !before.has(name),
  );
  const findings = placed.map(([name, { sdk, facts }]) => ({
    rule: "RW-A01",
    severity: "medium",
    title: `Browser code may call ${sdk.provider} directly through ${name}`,
    summary: `${context.labels.right} imports ${name}, the ${sdk.label}, in code Release Watch classifies as browser code; ${used.has(name) ? `no module of ${old} that used it was classified that way` : `REA saw no use of it in ${old}`}.`,
    why: `The ${sdk.label} sends requests to ${sdk.provider} unless the code points it elsewhere, so prompts and user data may go to ${sdk.provider} straight from users' browsers. ${browserRisk(sdk.provider)}`,
    recommendation: ROUTE,
    evidence: [
      ...facts.map((fact) =>
        cite(`${fact.data.module} imports ${fact.key}`, fact, APP_SOURCE),
      ),
      BROWSER_CODE,
    ],
    unknowns: [
      "REA does not report which host the SDK contacts or what its requests contain.",
      BROWSER_LIMIT,
    ],
  }));
  return { findings, sdks: placed.map(([name]) => name) };
};
