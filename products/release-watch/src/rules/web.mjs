// Web build rules: third-party scripts in HTML, service workers, shipped
// original sources and direct eval.
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  hostOf,
  isVendorHost,
  newFacts,
  packResult,
} from "./shared.mjs";

const scriptHost = (scriptPath) =>
  hostOf(scriptPath.startsWith("//") ? `https:${scriptPath}` : scriptPath);

const scriptFindings = (context) => {
  const { labels, options, network } = context;
  const findings = [];
  const hosts = [];
  for (const { fact, status } of newFacts(context.diff.app.pageScripts)) {
    if (fact.data.resolution_status !== "external") continue;
    const host = scriptHost(fact.data.script_path);
    if (host === null) continue;
    hosts.push(host);
    if (isVendorHost(host, options.vendorDomains) || network.own.has(host))
      continue;
    const knownHost = network.known.has(host);
    findings.push({
      rule: "RW-W01",
      severity: knownHost ? "medium" : "high",
      title: knownHost
        ? `New script from ${host}`
        : `New third-party script: ${host}`,
      summary: `${labels.right}'s HTML loads ${fact.data.script_path}.`,
      why: "A third-party script runs with full access to the page, its data and its users' sessions. The 2024 polyfill.io takeover used exactly this path.",
      recommendation:
        "Self-host the script or pin it with Subresource Integrity, and confirm what data the vendor collects.",
      evidence: [
        cite(
          `<script src="${fact.data.script_path}"> (${absencePhrase(status, labels.left)})`,
          fact,
          APP_SOURCE,
        ),
      ],
      unknowns: [
        "REA does not report integrity or crossorigin attributes, so Release Watch cannot tell whether the script is pinned.",
      ],
    });
  }
  return { findings, hosts };
};

const serviceWorkerFindings = (context) =>
  newFacts(context.diff.app.serviceWorkers).map(({ fact, status }) => ({
    rule: "RW-W02",
    severity: "medium",
    title: `New service worker: ${fact.data.specifier}`,
    summary: `${context.labels.right} registers a service worker that can intercept the site's requests.`,
    why: "A service worker persists in users' browsers and sees every request the site makes, even after the page closes.",
    recommendation:
      "Review what the worker caches and forwards, and confirm it ships an update and unregister path.",
    evidence: [
      cite(
        `navigator.serviceWorker.register("${fact.data.specifier}") (${absencePhrase(status, context.labels.left)})`,
        fact,
        APP_SOURCE,
      ),
    ],
    unknowns: [],
  }));

const embeddedSourceFindings = (context) => {
  const added = newFacts(context.diff.app.embeddedSources);
  if (added.length === 0) return [];
  return [
    {
      rule: "RW-W03",
      severity: "low",
      title: `Source maps now ship ${added.length} original source file${added.length === 1 ? "" : "s"}`,
      summary: `${context.labels.right} publishes source maps with embedded original sources.`,
      why: "Embedded sources reveal unminified code, comments and internal paths to anyone who opens the site.",
      recommendation:
        "Upload source maps to your error tracker instead of serving them, or strip sourcesContent.",
      evidence: added
        .slice(0, 6)
        .map(({ fact, status }) =>
          cite(
            `${fact.data.original} (${absencePhrase(status, context.labels.left)})`,
            fact,
            APP_SOURCE,
          ),
        ),
      unknowns: [],
    },
  ];
};

const evalFindings = (context) =>
  newFacts(context.diff.app.dynamicEvaluation).map(({ fact, status }) => ({
    rule: "RW-W04",
    severity: "low",
    title: `New direct eval in ${fact.data.module}`,
    summary: `${context.labels.right} evaluates code built at runtime in ${fact.data.module}.`,
    why: "eval turns any string that reaches it into running code and blocks a strict Content-Security-Policy.",
    recommendation: "Replace eval with explicit code paths.",
    evidence: [
      cite(
        `${fact.data.detail ?? "eval can declare bindings at runtime"} (${absencePhrase(status, context.labels.left)})`,
        fact,
        APP_SOURCE,
      ),
    ],
    unknowns: ["REA does not resolve what string reaches eval."],
  }));

// Requests made inside a new service worker forward the page's own traffic;
// RW-W02 explains them.
const serviceWorkerRequests = (context) => {
  const workers = new Set(
    newFacts(context.diff.app.serviceWorkers).map(
      ({ fact }) => fact.data.specifier,
    ),
  );
  return (context.right.app?.requests ?? [])
    .filter((request) => workers.has(request.data.module))
    .map((request) => request.node_id);
};

/** Web rules; claims script hosts and service-worker requests so generic rules do not repeat them. */
export const webPack = (context) => {
  const scripts = scriptFindings(context);
  return packResult(
    [
      ...scripts.findings,
      ...serviceWorkerFindings(context),
      ...embeddedSourceFindings(context),
      ...evalFindings(context),
    ],
    { hosts: scripts.hosts, nodes: serviceWorkerRequests(context) },
  );
};
