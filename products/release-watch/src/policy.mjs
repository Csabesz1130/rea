// Turns a component diff into graded findings, and findings into a verdict.
import { aiPack } from "./rules/ai.mjs";
import { electronPack } from "./rules/electron.mjs";
import { helpersPack } from "./rules/helpers.mjs";
import { mcpPack } from "./rules/mcp.mjs";
import { networkPack, networkView } from "./rules/network.mjs";
import { processPack } from "./rules/process.mjs";
import { runtimePack } from "./rules/runtime.mjs";
import { maxSeverity, severityRank } from "./rules/shared.mjs";
import { webPack } from "./rules/web.mjs";

// Specific packs run first and claim the hosts and process sites they
// explain, so the generic network and process packs do not repeat them.
const PACKS = [
  electronPack,
  mcpPack,
  aiPack,
  webPack,
  runtimePack,
  helpersPack,
  processPack,
  networkPack,
];

/** Findings for one component and the network view they were graded against. */
export const evaluateComponent = (component) => {
  const context = {
    ...component,
    network: networkView(component.left, component.right),
    claimed: { hosts: new Set(), nodes: new Set() },
  };
  const findings = [];
  for (const pack of PACKS) {
    const result = pack(context);
    findings.push(
      ...result.findings.map((finding) => ({
        component: component.name,
        ...finding,
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
 * "error" when a component could not be analyzed, "block" when any finding
 * reaches the threshold, "review" for medium findings, otherwise "pass".
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
  });
  if (errors.length > 0) return verdict("error");
  if (
    findings.length > 0 &&
    failOn !== "never" &&
    severityRank(highest) >= severityRank(failOn)
  )
    return verdict("block");
  if (severityRank(highest) >= severityRank("medium")) return verdict("review");
  return verdict("pass");
};
