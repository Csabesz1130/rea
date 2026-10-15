// Synthetic REA facts and a one-component policy run for rule tests.
import { pairHelpers, pairRuntimes } from "../src/pairing.mjs";
import { diffApplications, diffCaptures } from "../src/diff.mjs";
import { deploymentOf } from "../src/facts/capture.mjs";
import { evaluateComponent } from "../src/policy.mjs";

export const at = (file, line, column = 0) => ({ file, line, column });
export const range = (line, startColumn, endLine, endColumn) => ({
  start: { line, column: startColumn },
  end: { line: endLine, column: endColumn },
});
export const fact = (key, data, location = null, state = "observed") => ({
  key,
  label: key,
  node_id: `${key}@${location?.file}:${location?.line}`,
  location,
  state,
  authority: "test",
  confidence: "exact",
  artifact_sha256: null,
  data,
});

export const app = (overrides = {}) => ({
  coverage: {
    graph: "complete",
    graph_truncated: false,
    graph_omitted: 0,
    semantic: "partial",
    semantic_truncated: false,
    semantic_omitted_nodes: 0,
    semantic_limits: [],
    semantic_ceiling_modules: [],
  },
  limitations: [],
  analysisFailures: [],
  summary: { sender_validation_observations: 0 },
  modules: new Map(),
  imports: [],
  browserModules: new Set(),
  assets: [],
  ipcHandlers: [],
  bridgeMembers: [],
  windows: [],
  packages: [],
  endpoints: [],
  pageScripts: [],
  serviceWorkers: [],
  embeddedSources: [],
  storage: [],
  requests: [],
  childProcesses: [],
  timers: [],
  configReads: [],
  stringLiterals: [],
  urlLiterals: [],
  bindingReads: [],
  functions: [],
  calls: [],
  members: [],
  htmlSinks: [],
  memberCalls: [],
  dynamicEvaluation: [],
  inlineScripts: 0,
  ...overrides,
});

export const side = (label, application, extra = {}) => ({
  label,
  target: { root: `/releases/${label}`, kind: "js-app" },
  app: application,
  runtimes: [],
  runtimeStatus: { candidates: 0, failures: [] },
  helpers: [],
  capture: null,
  ...extra,
});

export const evaluate = (
  left,
  right,
  {
    options = {},
    surfaces = [],
    aliases = new Map(),
    helpers = [],
    comparison = null,
    baseline = undefined,
    ambiguous = new Set(),
    release = undefined,
    name = "app",
  } = {},
) =>
  evaluateComponent({
    name,
    release,
    left,
    right,
    comparison,
    aliases,
    ambiguous,
    baseline,
    surfaces,
    labels: { left: left.label, right: right.label },
    options: { vendorDomains: [], failOn: "high", ...options },
    deployment: deploymentOf(
      left.capture,
      right.capture,
      options.vendorDomains ?? [],
    ),
    diff: {
      app: diffApplications(left.app, right.app, aliases),
      runtimes: pairRuntimes(left, right),
      helpers: helpers.length > 0 ? helpers : pairHelpers(left, right),
      capture: diffCaptures(left.capture, right.capture),
    },
  }).findings;

export const rules = (findings) =>
  findings.map((finding) => finding.rule).sort();
