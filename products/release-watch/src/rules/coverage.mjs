// Coverage rules: what REA or Release Watch could not examine. A rule that
// found nothing only means something when the code was examined, so limits
// on the new side become findings instead of a silent pass.
import { SECURITY_HEADERS } from "../catalog.mjs";
import { APP_SOURCE, cite, packResult, reported } from "./shared.mjs";

const COMPONENT = "Release Watch";
const MAX_FILES = 6;

const applicationGaps = (app) => {
  const { coverage } = app;
  const lines = [];
  if (coverage.graph !== "complete" || coverage.graph_truncated)
    lines.push(
      reported(
        `Application graph coverage is ${coverage.graph}${coverage.graph_omitted > 0 ? `, ${coverage.graph_omitted} items omitted` : ""}`,
        "observed",
        APP_SOURCE,
      ),
    );
  if (coverage.semantic === "unavailable")
    lines.push(
      reported(
        "REA produced no semantic graph, so requests, processes and literals were not examined",
        "observed",
        APP_SOURCE,
      ),
    );
  if (coverage.semantic_truncated || (coverage.semantic_omitted_nodes ?? 0) > 0)
    lines.push(
      reported(
        `Semantic graph truncated${coverage.semantic_omitted_nodes ? ` (${coverage.semantic_omitted_nodes} nodes omitted)` : ""}${coverage.semantic_limits.length > 0 ? ` at ${coverage.semantic_limits.join(", ")}` : ""}`,
        "observed",
        APP_SOURCE,
      ),
    );
  const files = coverage.semantic_ceiling_modules;
  if (files.length > 0)
    lines.push(
      reported(
        `Files that reached REA's per-file node ceiling: ${files.slice(0, MAX_FILES).join(", ")}${files.length > MAX_FILES ? ` and ${files.length - MAX_FILES} more` : ""}`,
        "derived",
        APP_SOURCE,
      ),
    );
  for (const failure of app.analysisFailures.slice(0, MAX_FILES))
    lines.push(
      cite(
        `REA could not analyze a file: ${failure.data.code ?? "unknown"} ${failure.data.message ?? ""}`.trim(),
        failure,
        APP_SOURCE,
      ),
    );
  return lines;
};

// RW-C01: the new side's code was only partly examined.
const incompleteAnalysis = (context) => {
  const app = context.right.app;
  if (!app) return [];
  const evidence = applicationGaps(app);
  if (evidence.length === 0) return [];
  return [
    {
      rule: "RW-C01",
      severity: "medium",
      title: `Analysis of ${context.labels.right} is incomplete`,
      summary: `REA examined only part of ${context.labels.right}'s code; findings in the unexamined part are missing from this report.`,
      why: "A pass is meaningful only for code that was examined. Large bundles are where injected code hides most easily.",
      recommendation:
        "Re-run with higher REA limits (--max-semantic-nodes-per-file, --max-heap-mb), or review the listed files by other means.",
      evidence,
      unknowns: ["Release Watch cannot tell what the unexamined code does."],
    },
  ];
};

// Old pages that sent security headers and have no counterpart in the new capture.
const unmatchedPages = (context) =>
  context.left.capture && context.diff.capture
    ? context.diff.capture.documents
        .filter(
          (item) =>
            item.right.length === 0 &&
            item.left.some((page) =>
              Object.keys(page.data.headers).some(
                (name) => name in SECURITY_HEADERS,
              ),
            ),
        )
        .map((item) => item.key)
    : [];

// RW-C02: pieces that could only be seen on one side, so nothing was compared.
const oneSided = (context) => {
  const { left, right, labels, comparison, name } = context;
  const lines = [];
  if (left.target === null)
    lines.push(
      `Component ${name} is new in ${labels.right}; every fact in it is reported as not previously observed.`,
    );
  if (right.target === null)
    lines.push(
      `Component ${name} is missing from ${labels.right}; nothing in it was compared.`,
    );
  if (
    left.target !== null &&
    right.target !== null &&
    (left.capture === null) !== (right.capture === null)
  )
    lines.push(
      left.capture
        ? `Only ${labels.left} has a runtime capture, so runtime rules did not run for ${labels.right}.`
        : `Only ${labels.right} has a runtime capture, so header and cookie changes were not compared.`,
    );
  for (const path of unmatchedPages(context))
    lines.push(
      `The ${labels.right} capture has no page at ${path} to compare with ${labels.left}'s security headers.`,
    );
  if (comparison?.error)
    lines.push(
      `REA could not pair renamed modules (${comparison.error.code ?? "error"}); a renamed bundle may be reported as new code.`,
    );
  if (comparison?.skipped === "size")
    lines.push(
      `REA's module pairing was skipped because the Evidence is too large; a renamed bundle may be reported as new code.`,
    );
  if (lines.length === 0) return [];
  return [
    {
      rule: "RW-C02",
      severity: "low",
      title: `Parts of ${name} were seen on one side only`,
      summary: lines[0],
      why: "Rules compare the two releases; what exists on one side only cannot be compared.",
      recommendation:
        "Provide the missing side, or review these parts directly.",
      evidence: lines.map((line) => reported(line, "derived", COMPONENT)),
      unknowns: [],
    },
  ];
};

// RW-C03: the old release had readable fuses and the new one does not.
const fuseCoverage = (context) => {
  const before = context.left.runtime?.fuses ?? null;
  if (before === null || before.ambiguous) return [];
  const after = context.right.runtime?.fuses ?? null;
  const lost = context.diff.fuses.filter(
    (change) => change.after !== "enabled" && change.after !== "disabled",
  );
  const lines =
    after === null
      ? [
          `REA found no Electron fuse wire in ${context.labels.right}'s executables`,
        ]
      : after.ambiguous
        ? [
            `REA found ${after.sentinel_count} fuse wires in ${context.right.runtime.name}, so no fuse state is established`,
          ]
        : lost.map(
            (change) => `${change.name}: ${change.before} → ${change.after}`,
          );
  if (lines.length === 0) return [];
  return [
    {
      rule: "RW-C03",
      severity: "medium",
      title: `Electron fuse state unknown in ${context.labels.right}`,
      summary: `${context.labels.left}'s fuses were readable; ${context.labels.right}'s are not, so fuse regressions cannot be ruled out.`,
      why: "Fuses block well-known ways to run code inside a signed app; an unreadable wire may hide a regression.",
      recommendation:
        "Inspect the new executable's fuses with @electron/fuses or ask the vendor for the build configuration.",
      evidence: lines.map((line) =>
        reported(line, "observed", "REA inspect_electron_fuses"),
      ),
      unknowns: [],
    },
  ];
};

// RW-C04: a helper REA identified as Go before is not identified now.
const helperCoverage = (context) =>
  context.diff.helpers
    .filter((helper) => helper.before?.go && helper.after && !helper.after.go)
    .map((helper) => ({
      rule: "RW-C04",
      severity: "medium",
      title: `${helper.relative} could not be analyzed in ${context.labels.right}`,
      summary: `REA read Go build information from ${helper.relative} in ${context.labels.left} but not in ${context.labels.right}.`,
      why: "A helper that changed toolchain or packing deserves a look; its dependencies and build settings were not compared.",
      recommendation: "Ask the vendor how the helper is now built.",
      evidence: [
        reported(
          `REA result for ${context.labels.right}: ${helper.after.identified}`,
          "observed",
          "REA inspect_go_binary",
        ),
      ],
      unknowns: [],
    }));

/** Coverage rules. */
export const coveragePack = (context) =>
  packResult([
    ...incompleteAnalysis(context),
    ...oneSided(context),
    ...fuseCoverage(context),
    ...helperCoverage(context),
  ]);
