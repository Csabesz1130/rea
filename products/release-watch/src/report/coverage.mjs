// Coverage and limits for the report: what each side's analysis could not
// examine, and what Release Watch and REA never establish.
import path from "node:path";

import { captureUnread } from "../facts/capture.mjs";
import { failedFiles, unexaminedIn } from "../facts/coverage.mjs";

// What Release Watch itself never examines; true of every run.
export const RELEASE_WATCH_LIMITS = [
  "Release Watch compares REA facts. It does not execute either release during comparison; captures come from a browser session recorded separately.",
  '"New" means REA saw it only in the new release; REA\'s coverage of the old release does not prove it was absent.',
  "Rules recognise known patterns. A pass means no rule matched in the examined code, not that the release is safe.",
];

const COMPARISON_NOTES = {
  disabled:
    "REA module pairing was turned off (--rea-compare never); renamed modules are paired by name only.",
  "no-renames": null,
  size: "REA module pairing was skipped because the Evidence is larger than 64 MB; renamed modules are paired by name only.",
};

// How many files a coverage line names in full; report.json keeps them all.
const MAX_NAMED = 10;

const named = (files) =>
  `${files.slice(0, MAX_NAMED).join(", ")}${files.length > MAX_NAMED ? ` and ${files.length - MAX_NAMED} more` : ""}`;

// What REA examined in part or not at all on one side, as facts/coverage.mjs
// reads it: files at the per-file ceiling, files the global limit left
// without semantic facts, the global limit itself, and failed files.
const unexaminedGaps = (app) => {
  const { files, anyFile } = unexaminedIn(app);
  const why = (reason) =>
    [...files].filter(([, of]) => of === reason).map(([file]) => file);
  const ceiling = why("ceiling");
  const unreached = why("unreached");
  const failed = failedFiles(app).length;
  return [
    ...(ceiling.length > 0
      ? [`Files at the per-file node ceiling: ${named(ceiling)}.`]
      : []),
    ...(unreached.length > 0
      ? [
          `${unreached.length} script file(s) with no semantic facts after REA's global node limit: ${named(unreached)}.`,
        ]
      : []),
    ...(anyFile
      ? [
          "REA reached its global node limit, so any file it analyzed may have been examined only in part.",
        ]
      : []),
    ...(failed > 0 ? [`REA could not analyze ${failed} file(s).`] : []),
  ];
};

const appGaps = (app) => {
  const { coverage } = app;
  return [
    ...(coverage.graph !== "complete"
      ? [`REA reports application graph coverage as ${coverage.graph}.`]
      : []),
    ...(coverage.semantic === "unavailable"
      ? [
          "No semantic graph: requests, processes and literals were not examined.",
        ]
      : []),
    ...(coverage.semantic_truncated
      ? [
          `Semantic graph truncated${coverage.semantic_limits.length ? ` (limits: ${coverage.semantic_limits.join(", ")})` : ""}.`,
        ]
      : []),
    ...unexaminedGaps(app),
  ];
};

// Specific gaps in what REA examined on one side, then REA's standing
// limitations for the operations that ran.
const sideCoverage = (side) => {
  const gaps = [];
  const limitations = [];
  if (side.target && side.target.app && !side.app)
    gaps.push(
      "REA could not analyze this side's code; nothing in it was compared.",
    );
  if (side.app) {
    gaps.push(...appGaps(side.app));
    limitations.push(...side.app.limitations);
  }
  for (const runtime of side.runtimes) {
    if (runtime.fuses.ambiguous)
      gaps.push(
        `${runtime.name}: several fuse wires, so no fuse state is established.`,
      );
    limitations.push(...runtime.fuses.limitations);
  }
  for (const failure of side.runtimeStatus?.failures ?? [])
    gaps.push(`REA's fuse inspection of ${failure.name} failed.`);
  for (const helper of side.helpers)
    if (helper.identified !== "go")
      gaps.push(
        helper.identified === "failed"
          ? `REA could not inspect ${helper.relative}, so its build information is not established.`
          : `${helper.relative}: REA found no Go build information.`,
      );
  if (captureUnread(side))
    gaps.push(
      `REA could not read the capture ${path.basename(side.target.capture)}; no runtime facts from it were compared.`,
    );
  if (side.capture) {
    gaps.push(...side.capture.gaps);
    limitations.push(...side.capture.limitations);
  }
  return { gaps: [...new Set(gaps)], limitations: [...new Set(limitations)] };
};

export const coverageOf = (component) => ({
  left: sideCoverage(component.left),
  right: sideCoverage(component.right),
  comparison: component.comparison?.error
    ? `REA module pairing failed: ${component.comparison.error.message}`
    : (COMPARISON_NOTES[component.comparison?.skipped] ?? null),
  rea_comparison_limitations: component.comparison?.limitations ?? [],
});
