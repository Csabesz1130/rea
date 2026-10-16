// Turns a component diff into graded findings, and findings into a verdict.
import { deploymentHosts } from "./facts/capture.mjs";
import { aiPack, shippedTokens } from "./rules/ai.mjs";
import { coveragePack } from "./rules/coverage.mjs";
import { dependencyPack, packagesOf } from "./rules/dependencies.mjs";
import { electronPack } from "./rules/electron.mjs";
import { goPack } from "./rules/go.mjs";
import { mcpPack } from "./rules/mcp.mjs";
import {
  browserHosts,
  guessedHosts,
  knownHosts,
  networkPack,
  networkView,
} from "./rules/network.mjs";
import { processPack } from "./rules/process.mjs";
import { runtimePack } from "./rules/runtime.mjs";
import { maxSeverity, severityRank } from "./rules/shared.mjs";
import { shipsOriginals, webPack } from "./rules/web.mjs";
import { releaseWindowPairing } from "./rules/window-pairing.mjs";
import { releaseMoves } from "./moves.mjs";
import { sdkUses } from "./surfaces.mjs";

// Specific packs run first and claim the hosts and process sites they
// explain, so the generic network and process packs do not repeat them.
const PACKS = [
  electronPack,
  mcpPack,
  aiPack,
  webPack,
  runtimePack,
  goPack,
  processPack,
  networkPack,
  dependencyPack,
  coveragePack,
];

/**
 * What the whole old release contained, across components: hosts it
 * contacted, packages it imported and AI or MCP SDKs it used. A component
 * that is new, renamed or split off is graded against this, not against an
 * empty side.
 */
/**
 * Sites the release gained and lost, paired one to one across components.
 * `components` is `[{ name, diff, comparable, left, right }]`; a component
 * is not comparable when REA could not analyze its new side.
 */
export const releaseMovesOf = (components) => ({
  childProcesses: releaseMoves(
    components.map(({ name, diff, comparable }) => ({
      name,
      items: diff.app.childProcesses,
      comparable,
    })),
    { field: "command" },
  ),
  requests: releaseMoves(withDigests(components, "requests"), {
    field: "endpoint",
    keep: (fact) => !fact.data.endpoint,
    unresolvedPairs: true,
    sameFile: "across",
  }),
  // A sink means what the code around it does, so it moves with its file.
  htmlSinks: releaseMoves(withDigests(components, "htmlSinks"), {
    field: "sink",
    sameFile: "always",
  }),
});

const withDigests = (components, family) =>
  components.map(({ name, diff, comparable, left, right }) => ({
    name,
    items: diff.app[family],
    comparable,
    digests: { left: digestsOf(left), right: digestsOf(right) },
  }));

const digestsOf = (side) =>
  new Map(
    (side?.app?.assets ?? []).map((asset) => [asset.key, asset.data.sha256]),
  );

export const releaseBaseline = (leftSides) => ({
  apps: leftSides.filter((side) => side.app).length,
  hosts: new Set(leftSides.flatMap((side) => [...knownHosts(side)])),
  browserHosts: new Set(leftSides.flatMap((side) => [...browserHosts(side)])),
  shipsOriginals: leftSides.some((side) => shipsOriginals(side.app)),
  guessed: new Set(leftSides.flatMap((side) => [...guessedHosts(side)])),
  packages: new Set(
    leftSides.flatMap((side) => [...packagesOf(side.app).keys()]),
  ),
  sdks: new Set(leftSides.flatMap((side) => [...sdkUses(side.app).keys()])),
  credentials: new Set(
    leftSides.flatMap((side) =>
      (side.capture?.credentials ?? []).map((fact) => fact.key),
    ),
  ),
  ...shippedTokensOf(leftSides),
  digests: new Set(
    leftSides
      .flatMap((side) => side.app?.assets ?? [])
      .map((asset) => asset.data.sha256)
      .filter(Boolean),
  ),
});

// Credential tokens the old release shipped anywhere, and in browser code.
const shippedTokensOf = (leftSides) => {
  const shipped = leftSides.map((side) => shippedTokens(side.app));
  return {
    tokens: new Set(shipped.flatMap((entry) => [...entry.all])),
    browserTokens: new Set(shipped.flatMap((entry) => [...entry.browser])),
  };
};

// What limits a finding located in a given file: a bundle Release Watch
// could not pair with its old version, or an old file REA could not fully
// analyze, so the "new" fact may have been there before.
const locatedUnknowns = (finding, component) => {
  const files = [
    ...new Set(
      finding.evidence.map((item) => item.location?.file).filter(Boolean),
    ),
  ];
  const ambiguous = component.ambiguous ?? new Set();
  const oldApp = component.left?.app;
  const unexamined = new Set([
    ...(oldApp?.analysisFailures ?? [])
      .map((failure) => failure.location?.file)
      .filter(Boolean),
    ...(oldApp?.coverage.semantic_ceiling_modules ?? []),
  ]);
  const elsewhere = [...unexamined].filter((file) => !files.includes(file));
  return [
    ...files.flatMap((file) =>
      located(component, { file, ambiguous, unexamined }),
    ),
    ...(elsewhere.length > 0 && finding.rule !== "RW-C01"
      ? [
          `REA could not fully analyze ${elsewhere.length} file${elsewhere.length === 1 ? "" : "s"} of ${component.labels.left} (${elsewhere.slice(0, 3).join(", ")}), so what is reported here may have been there before.`,
        ]
      : []),
  ];
};

const located = (component, { file, ambiguous, unexamined }) => [
  ...(ambiguous.has(file)
    ? [
        `Several bundles share ${file}'s name without its content hash, so Release Watch could not pair it with its old version; what it reports here may predate this release.`,
      ]
    : []),
  ...(unexamined.has(file)
    ? [
        `REA could not fully analyze ${file} in ${component.labels.left}, so what is reported here may predate this release.`,
      ]
    : []),
];

/** Findings for one component and the network view they were graded against. */
export const evaluateComponent = (component) => {
  const baseline = component.baseline ?? releaseBaseline([component.left]);
  // Captures are keyed by the deployment when the component is prepared.
  const own =
    component.deployment ??
    deploymentHosts(
      [component.left.capture, component.right.capture],
      component.options?.vendorDomains ?? [],
    );
  const context = {
    ...component,
    baseline,
    moves:
      component.release?.moves ??
      releaseMovesOf([{ ...component, comparable: true }]),
    windows: component.release?.windows ?? releaseWindowPairing([component]),
    aliases: component.aliases ?? new Map(),
    network: networkView(component.left, component.right, baseline, {
      ignoreCapture: component.captureBaselineFailed === true,
      own,
    }),
    claimed: { hosts: new Set(), nodes: new Set() },
  };
  const findings = [];
  for (const pack of component.coverageOnly ? [coveragePack] : PACKS) {
    const result = pack(context);
    findings.push(
      ...result.findings.map((finding) => ({
        component: component.name,
        ...finding,
        unknowns: [...finding.unknowns, ...locatedUnknowns(finding, component)],
      })),
    );
    result.claims.hosts.forEach((host) => context.claimed.hosts.add(host));
    result.claims.nodes.forEach((node) => context.claimed.nodes.add(node));
  }
  return { findings, network: context.network };
};

/** Number findings across components after ordering them by severity. */
export const numberFindings = (findings) =>
  [...findings]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .map((finding, index) => ({ id: `F${index + 1}`, ...finding }));

/**
 * "block" when any finding reaches the threshold, even if another component
 * could not be analyzed; "error" when a component could not be analyzed;
 * "review" for medium findings; otherwise "pass".
 */
export const verdictFor = (findings, failOn, { errors = [] } = {}) => {
  const highest = maxSeverity(findings.map((finding) => finding.severity));
  const counts = Object.fromEntries(
    ["critical", "high", "medium", "low", "info"].map((severity) => [
      severity,
      findings.filter((finding) => finding.severity === severity).length,
    ]),
  );
  const verdict = (decision) => ({
    decision,
    highest,
    counts,
    fail_on: failOn,
    errors: errors.length,
  });
  if (
    findings.length > 0 &&
    failOn !== "never" &&
    severityRank(highest) >= severityRank(failOn)
  )
    return verdict("block");
  if (errors.length > 0) return verdict("error");
  if (severityRank(highest) >= severityRank("medium")) return verdict("review");
  return verdict("pass");
};
