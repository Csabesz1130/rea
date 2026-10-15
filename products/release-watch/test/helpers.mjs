// Synthetic REA facts and a one-component policy run for rule tests.
import { diffApplications, diffCaptures, diffFuses } from "../src/diff.mjs";
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
  coverage: { graph: "complete", semantic: "partial" },
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
  htmlSinks: [],
  memberCalls: [],
  dynamicEvaluation: [],
  inlineScripts: 0,
  ...overrides,
});

export const side = (label, application, extra = {}) => ({
  label,
  app: application,
  runtime: null,
  helpers: [],
  capture: null,
  ...extra,
});

export const evaluate = (
  left,
  right,
  { options = {}, surfaces = [], aliases = new Map() } = {},
) =>
  evaluateComponent({
    name: "app",
    left,
    right,
    surfaces,
    labels: { left: left.label, right: right.label },
    options: { vendorDomains: [], failOn: "high", ...options },
    diff: {
      app: diffApplications(left.app, right.app, aliases),
      fuses: diffFuses(
        left.runtime?.fuses ?? null,
        right.runtime?.fuses ?? null,
      ),
      helpers: [],
      capture: diffCaptures(left.capture, right.capture),
    },
  }).findings;

export const rules = (findings) =>
  findings.map((finding) => finding.rule).sort();
