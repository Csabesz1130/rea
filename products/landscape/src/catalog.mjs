// Product knowledge Landscape adds to Release Watch's catalog: which hosts
// and packages send analytics, error reports or session recordings (a known
// service, or a host whose name says telemetry), which
// local addresses serve models, which packages run interactive terminals
// and which check a registry for updates. Matches here are Landscape's
// heuristics, never REA observations; reports label them so.

const suffixOf = (host, suffix) =>
  host === suffix || host.endsWith(`.${suffix}`);

// Telemetry services by the host suffix their collectors use, with the kind
// of data each collects.
const TELEMETRY_HOSTS = [
  {
    suffix: "google-analytics.com",
    service: "Google Analytics",
    kind: "analytics",
  },
  {
    suffix: "analytics.google.com",
    service: "Google Analytics",
    kind: "analytics",
  },
  {
    suffix: "googletagmanager.com",
    service: "Google Tag Manager",
    kind: "analytics",
  },
  { suffix: "segment.io", service: "Segment", kind: "analytics" },
  { suffix: "segment.com", service: "Segment", kind: "analytics" },
  { suffix: "mixpanel.com", service: "Mixpanel", kind: "analytics" },
  { suffix: "posthog.com", service: "PostHog", kind: "analytics" },
  { suffix: "amplitude.com", service: "Amplitude", kind: "analytics" },
  { suffix: "plausible.io", service: "Plausible", kind: "analytics" },
  { suffix: "heap.io", service: "Heap", kind: "analytics" },
  { suffix: "heapanalytics.com", service: "Heap", kind: "analytics" },
  { suffix: "statsig.com", service: "Statsig", kind: "analytics" },
  { suffix: "sentry.io", service: "Sentry", kind: "error reports" },
  { suffix: "bugsnag.com", service: "Bugsnag", kind: "error reports" },
  { suffix: "rollbar.com", service: "Rollbar", kind: "error reports" },
  { suffix: "honeybadger.io", service: "Honeybadger", kind: "error reports" },
  { suffix: "datadoghq.com", service: "Datadog", kind: "monitoring" },
  { suffix: "datadoghq.eu", service: "Datadog", kind: "monitoring" },
  { suffix: "nr-data.net", service: "New Relic", kind: "monitoring" },
  { suffix: "newrelic.com", service: "New Relic", kind: "monitoring" },
  { suffix: "honeycomb.io", service: "Honeycomb", kind: "monitoring" },
  {
    suffix: "applicationinsights.azure.com",
    service: "Azure Application Insights",
    kind: "monitoring",
  },
  {
    suffix: "dc.services.visualstudio.com",
    service: "Azure Application Insights",
    kind: "monitoring",
  },
  { suffix: "hotjar.com", service: "Hotjar", kind: "session recording" },
  {
    suffix: "clarity.ms",
    service: "Microsoft Clarity",
    kind: "session recording",
  },
  { suffix: "logrocket.io", service: "LogRocket", kind: "session recording" },
  { suffix: "logrocket.com", service: "LogRocket", kind: "session recording" },
  { suffix: "fullstory.com", service: "FullStory", kind: "session recording" },
];

// Packages whose purpose is sending telemetry, by name or scope.
const TELEMETRY_PACKAGES = [
  { scope: "@sentry/", service: "Sentry", kind: "error reports" },
  { name: "posthog-node", service: "PostHog", kind: "analytics" },
  { name: "posthog-js", service: "PostHog", kind: "analytics" },
  { name: "mixpanel", service: "Mixpanel", kind: "analytics" },
  { name: "mixpanel-browser", service: "Mixpanel", kind: "analytics" },
  { scope: "@segment/", service: "Segment", kind: "analytics" },
  { name: "analytics-node", service: "Segment", kind: "analytics" },
  { scope: "@amplitude/", service: "Amplitude", kind: "analytics" },
  {
    name: "universal-analytics",
    service: "Google Analytics",
    kind: "analytics",
  },
  { name: "@vercel/analytics", service: "Vercel Analytics", kind: "analytics" },
  { name: "@datadog/browser-rum", service: "Datadog", kind: "monitoring" },
  { name: "@datadog/browser-logs", service: "Datadog", kind: "monitoring" },
  { name: "dd-trace", service: "Datadog", kind: "monitoring" },
  { name: "newrelic", service: "New Relic", kind: "monitoring" },
  { scope: "@bugsnag/", service: "Bugsnag", kind: "error reports" },
  { name: "rollbar", service: "Rollbar", kind: "error reports" },
  {
    name: "applicationinsights",
    service: "Azure Application Insights",
    kind: "monitoring",
  },
  { name: "logrocket", service: "LogRocket", kind: "session recording" },
];

/** The telemetry service a host belongs to, `{ service, kind }`, or null. */
export const telemetryHost = (host) => {
  if (typeof host !== "string") return null;
  const entry = TELEMETRY_HOSTS.find((candidate) =>
    suffixOf(host, candidate.suffix),
  );
  return entry ? { service: entry.service, kind: entry.kind } : null;
};

// Words a collector's own host name carries (`telemetry.example.app`,
// `app-analytics-proxy.run.app`), as whole dash-separated parts of a label.
const TELEMETRY_WORDS = new Set(["telemetry", "analytics"]);

/** The telemetry word a host's name carries (`telemetry`), or null. */
export const telemetryWord = (host) => {
  if (typeof host !== "string") return null;
  for (const label of host.split("."))
    for (const part of label.split("-"))
      if (TELEMETRY_WORDS.has(part)) return part;
  return null;
};

/** The telemetry service a package sends to, `{ service, kind }`, or null. */
export const telemetryPackage = (name) => {
  if (typeof name !== "string") return null;
  const entry = TELEMETRY_PACKAGES.find((candidate) =>
    candidate.name !== undefined
      ? candidate.name === name
      : name.startsWith(candidate.scope),
  );
  return entry ? { service: entry.service, kind: entry.kind } : null;
};

// Local model servers by the port their documentation gives as default.
const LOCAL_MODEL_PORTS = new Map([
  ["11434", "Ollama"],
  ["1234", "LM Studio"],
]);

// Packages that are clients of a local model server.
const LOCAL_MODEL_PACKAGES = new Map([
  ["ollama", "Ollama"],
  ["ollama-ai-provider", "Ollama"],
  ["ollama-ai-provider-v2", "Ollama"],
  ["@lmstudio/sdk", "LM Studio"],
  ["node-llama-cpp", "llama.cpp"],
]);

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

/** The local model server a URL names by its loopback host and default port, or null. */
export const localModelUrl = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return LOOPBACK.test(parsed.hostname)
    ? (LOCAL_MODEL_PORTS.get(parsed.port) ?? null)
    : null;
};

/** The local model server a package is a client of, or null. */
export const localModelPackage = (name) =>
  LOCAL_MODEL_PACKAGES.get(name) ?? null;

// Packages that run a program in a pseudo-terminal: interactive sessions
// rather than one command at a time.
const PTY_PACKAGES = new Set([
  "node-pty",
  "@lydell/node-pty",
  "@homebridge/node-pty-prebuilt-multiarch",
  "node-pty-prebuilt-multiarch",
]);

/** True when a package runs programs in a pseudo-terminal. */
export const isPtyPackage = (name) => PTY_PACKAGES.has(name);

// Hosts and packages that check a registry for a newer version.
const UPDATE_HOSTS = new Set(["registry.npmjs.org", "registry.npmjs.com"]);
const UPDATE_PACKAGES = new Set([
  "update-notifier",
  "update-check",
  "simple-update-notifier",
  "latest-version",
  "package-json",
  "electron-updater",
  "update-electron-app",
]);

/** True when a host serves package versions to update checks. */
export const isUpdateHost = (host) => UPDATE_HOSTS.has(host);

/** True when a package checks for or installs a newer version. */
export const isUpdatePackage = (name) => UPDATE_PACKAGES.has(name);
