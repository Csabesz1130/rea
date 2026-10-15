// Web build rules: third-party scripts in HTML, service workers, shipped
// original sources and direct eval.
import { displayScript, scriptHostOf } from "../urls.mjs";
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  isVendorHost,
  newFacts,
  newGroups,
  packResult,
} from "./shared.mjs";

const scriptFindings = (context) => {
  const { labels, options, network } = context;
  const findings = [];
  const hosts = [];
  for (const { fact, status } of newFacts(context.diff.app.pageScripts)) {
    // External by the host a browser resolves, whatever REA's resolution
    // status says about a source with surrounding whitespace.
    const host = scriptHostOf(fact.data.script_path);
    if (host === null) continue;
    hosts.push(host);
    if (isVendorHost(host, options.vendorDomains) || network.own.has(host))
      continue;
    const knownHost = network.known.has(host);
    const source = displayScript(fact.data.script_path);
    findings.push({
      rule: "RW-W01",
      severity: knownHost ? "medium" : "high",
      title: knownHost
        ? `New script from ${host}`
        : `New third-party script: ${host}`,
      summary: `${labels.right}'s HTML loads a script from ${source}.`,
      why: "A third-party script runs with full access to the page, its data and its users' sessions. The 2024 polyfill.io takeover used exactly this path.",
      recommendation:
        "Self-host the script or pin it with Subresource Integrity, and confirm what data the vendor collects.",
      evidence: [
        cite(
          `HTML script reference to ${source} (${absencePhrase(status, labels.left)})`,
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
        `Service worker registration of ${fact.data.specifier} (${absencePhrase(status, context.labels.left)})`,
        fact,
        APP_SOURCE,
      ),
    ],
    unknowns: [],
  }));

// Reported only when the old release shipped no original sources at all; a
// release that already published them gains nothing new by adding files.
// Bundler runtime and external-module stubs a source map lists, which are
// not the product's own source files.
const isStub = (original) =>
  /^(webpack\/|external |\(webpack\)|\/?webpack\/bootstrap)/.test(original) ||
  / external /.test(original);

const embeddedSourceFindings = (context) => {
  // Unknown when REA could not analyze some old files: they may have shipped sources.
  if ((context.left.app?.analysisFailures.length ?? 0) > 0) return [];
  if (
    (context.left.app?.embeddedSources ?? []).some(
      (fact) => !isStub(fact.data.original),
    )
  )
    return [];
  const added = newFacts(context.diff.app.embeddedSources).filter(
    ({ fact }) => !isStub(fact.data.original),
  );
  if (added.length === 0) return [];
  return [
    {
      rule: "RW-W03",
      severity: "low",
      title: `Source maps now ship ${added.length} original source file${added.length === 1 ? "" : "s"}`,
      summary: `${context.labels.right} publishes source maps with embedded original sources; ${context.labels.left} published none REA could see.`,
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
  newGroups(context.diff.app.dynamicEvaluation).map((group) => {
    const [fact] = group.facts;
    return {
      rule: "RW-W04",
      severity: "low",
      title: `New direct eval in ${fact.data.module}`,
      summary: `${context.labels.right} evaluates code built at runtime in ${fact.data.module} (${absencePhrase(group.status, context.labels.left, group.counts)}).`,
      why: "eval turns any string that reaches it into running code and blocks a strict Content-Security-Policy.",
      recommendation: "Replace eval with explicit code paths.",
      evidence: group.facts.map((site) =>
        cite(
          site.data.detail ?? "eval can declare bindings at runtime",
          site,
          APP_SOURCE,
        ),
      ),
      unknowns: ["REA does not resolve what string reaches eval."],
    };
  });

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
