// Turns a release diff into graded findings and a verdict.
import {
  fuseRegressions,
  newBridgeMembers,
  newProcessExecution,
  rendererProcessExecution,
  webPreferenceRegressions,
} from "./rules/electron.mjs";
import { helperFindings } from "./rules/helpers.mjs";
import { newNetworkDestinations } from "./rules/network.mjs";
import { maxSeverity, severityRank } from "./rules/shared.mjs";

/** Evaluate every rule; findings are ordered most severe first. */
export const evaluatePolicy = (context) => {
  const execution = rendererProcessExecution(context);
  const findings = [
    ...execution.findings,
    ...newProcessExecution(context, execution.coveredExec),
    ...newNetworkDestinations(context),
    ...webPreferenceRegressions(context),
    ...fuseRegressions(context),
    ...helperFindings(context),
    ...newBridgeMembers(context, execution.coveredMembers),
  ];
  findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return findings.map((finding, index) => ({
    id: `F${index + 1}`,
    ...finding,
  }));
};

/** "block" when any finding reaches the threshold, "review" for medium findings, else "pass". */
export const verdictFor = (findings, failOn) => {
  const highest = maxSeverity(findings.map((finding) => finding.severity));
  const counts = Object.fromEntries(
    ["critical", "high", "medium", "low", "info"].map((severity) => [
      severity,
      findings.filter((finding) => finding.severity === severity).length,
    ]),
  );
  if (
    findings.length > 0 &&
    failOn !== "never" &&
    severityRank(highest) >= severityRank(failOn)
  )
    return { decision: "block", highest, counts, fail_on: failOn };
  if (severityRank(highest) >= severityRank("medium"))
    return { decision: "review", highest, counts, fail_on: failOn };
  return { decision: "pass", highest, counts, fail_on: failOn };
};
