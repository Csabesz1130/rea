// Turns a component diff into graded findings, and findings into a verdict.
import { deploymentHosts } from "./facts/capture.mjs";
import { partlyExamined, unexaminedIn } from "./facts/coverage.mjs";
import { aiPack, shippedTokens } from "./rules/ai.mjs";
import { browserSdkUses } from "./rules/ai-placement.mjs";
import { coveragePack } from "./rules/coverage.mjs";
import { dependencyPack, packagesOf } from "./rules/dependencies.mjs";
import { electronPack } from "./rules/electron.mjs";
import { goPack } from "./rules/go.mjs";
import { mcpPack } from "./rules/mcp.mjs";
import {
  browserGuessedHosts,
  browserHosts,
  contactSchemes,
  guessedHosts,
  knownHosts,
  mergeSchemes,
  namedHosts,
  withoutDestination,
} from "./rules/destinations.mjs";
import { releaseKeys } from "./rules/component-absence.mjs";
import { networkPack, networkView } from "./rules/network.mjs";
import { processPack } from "./rules/process.mjs";
import { runtimePack } from "./rules/runtime.mjs";
import { maxSeverity, severityRank } from "./rules/shared.mjs";
import { shipsOriginals, webPack } from "./rules/web.mjs";
import { releaseWindowPairing } from "./rules/window-pairing.mjs";
import { fileDigests, releaseMoves } from "./moves.mjs";
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
 * Sites the release gained and lost, paired one to one across components.
 * `components` is `[{ name, diff, comparable, left, right }]`, `name` the
 * component's identity; a component is not comparable when REA could not
 * analyze its new side.
 */
export const releaseMovesOf = (components) => ({
  childProcesses: releaseMoves(withDigests(components, "childProcesses"), {
    field: "command",
  }),
  // Only requests with no known destination move as unresolved sites; one
  // Release Watch binds to a URL literal is compared by its host instead.
  requests: releaseMoves(
    withDigests(components, "requests").map((component, index) => ({
      ...component,
      keep: {
        left: withoutDestination(components[index].left?.app),
        right: withoutDestination(components[index].right?.app),
      },
    })),
    { field: "endpoint", unresolvedPairs: true, sameFile: "across" },
  ),
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
    digests: { left: fileDigests(left?.app), right: fileDigests(right?.app) },
    partial: partlyExamined(right?.app),
  }));

/**
 * What the whole old release contained, across components: hosts it
 * contacted, only guessed at or named, and how it reached them, browser
 * placement, packages, AI or MCP SDKs, credentials, file contents, and the
 * keys of facts rules compare per component (`keys`). Windows are paired
 * release-wide instead (releaseWindowPairing). A component that is new,
 * renamed or split off is graded against this, not against an empty side.
 */
export const releaseBaseline = (leftSides) => ({
  apps: leftSides.filter((side) => side.app).length,
  hosts: new Set(leftSides.flatMap((side) => [...knownHosts(side)])),
  browserHosts: new Set(leftSides.flatMap((side) => [...browserHosts(side)])),
  browserGuessed: new Set(
    leftSides.flatMap((side) => [...browserGuessedHosts(side)]),
  ),
  schemes: mergeSchemes(...leftSides.map(contactSchemes)),
  shipsOriginals: leftSides.some((side) => shipsOriginals(side.app)),
  guessed: new Set(leftSides.flatMap((side) => [...guessedHosts(side)])),
  named: new Set(leftSides.flatMap((side) => [...namedHosts(side)])),
  packages: new Set(
    leftSides.flatMap((side) => [...packagesOf(side.app).keys()]),
  ),
  sdks: new Set(leftSides.flatMap((side) => [...sdkUses(side.app).keys()])),
  browserSdks: new Set(
    leftSides.flatMap((side) => [...browserSdkUses(side.app).keys()]),
  ),
  keys: releaseKeys(leftSides),
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

// Why REA's facts do not establish one old file, as a clause.
const UNEXAMINED = {
  ceiling: "could not fully analyze",
  failed: "could not fully analyze",
  unreached: "gave no semantic facts to",
};

// Findings that report what REA examined, not a fact new in the release.
const COVERAGE_NOTES = new Set(["RW-C01", "RW-C02", "RW-C03", "RW-C04"]);

// Old files REA did not fully examine outside a finding's own files, and
// REA's global node limit on the old release, as one sentence naming two of
// the files: the same text closes every finding about the new release.
const elsewhereUnknowns = (left, { elsewhere, anyFile }) => {
  if (elsewhere.length === 0)
    return anyFile
      ? [
          `REA reached its global node limit on ${left}, so it may have examined any of its files only in part, and what is reported here may have been there before.`,
        ]
      : [];
  const what = [...new Set(elsewhere.map(([, why]) => UNEXAMINED[why]))].join(
    " or ",
  );
  const named = elsewhere.slice(0, 2).map(([file]) => file);
  const more = elsewhere.length - named.length;
  return [
    `REA ${what} ${elsewhere.length} other file${elsewhere.length === 1 ? "" : "s"} of ${left} (${named.join(", ")}${more > 0 ? ` and ${more} more` : ""})${anyFile ? " and reached its global node limit there" : ""}, so what is reported here may have been there before.`,
  ];
};

// What limits a finding located in a given file: a bundle Release Watch
// could not pair with its old version, or an old file REA examined only in
// part or not at all (unexaminedIn), so the "new" fact may have been there
// before; and, for findings about the new release, the old files elsewhere
// REA did not fully examine and its global node limit on the old release.
const locatedUnknowns = (finding, component) => {
  const files = [
    ...new Set(
      finding.evidence.map((item) => item.location?.file).filter(Boolean),
    ),
  ];
  const ambiguous = component.ambiguous ?? new Set();
  const unexamined = unexaminedIn(component.left?.app);
  const elsewhere = [...unexamined.files].filter(
    ([file]) => !files.includes(file),
  );
  return [
    ...files.flatMap((file) =>
      located(component, { file, ambiguous, unexamined }),
    ),
    ...(COVERAGE_NOTES.has(finding.rule)
      ? []
      : elsewhereUnknowns(component.labels.left, {
          elsewhere,
          anyFile: unexamined.anyFile,
        })),
  ];
};

const located = (component, { file, ambiguous, unexamined }) => [
  ...(ambiguous.has(file)
    ? [
        `Several bundles share ${file}'s name without its content hash, so Release Watch could not pair it with its old version; what it reports here may predate this release.`,
      ]
    : []),
  ...(unexamined.files.has(file)
    ? [
        `REA ${UNEXAMINED[unexamined.files.get(file)]} ${file} in ${component.labels.left}, so what is reported here may predate this release.`,
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
      releaseMovesOf([{ ...component, name: component.id, comparable: true }]),
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
