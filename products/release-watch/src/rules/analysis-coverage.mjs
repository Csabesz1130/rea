// RW-C01: what REA could not examine in the new release, graded by whether
// that code changed since the old release, and the changed-file tests the
// coverage rules share.
import { renamedFrom } from "../diff.mjs";
import { examinedInPart } from "../facts/coverage.mjs";
import { shippedBefore } from "../moves.mjs";
import { gapLine, processGapsOf } from "./process-gaps.mjs";
import { APP_SOURCE, cite, reported } from "./shared.mjs";

const COMPONENT = "Release Watch";
export const MAX_FILES = 6;

const listed = (files) =>
  `${files.slice(0, MAX_FILES).join(", ")}${files.length > MAX_FILES ? ` and ${files.length - MAX_FILES} more` : ""}`;

// Files whose content the old release did not ship, in any component or
// under any path (moves.mjs shippedBefore owns that test, so a file that
// moved unchanged did not change, and one REA reported no digest for did).
// Every file of a component new in this release is compared the same way.
// Unknown when REA could not analyze the old side of a component the old
// release had: nothing is called changed then.
export const changedFiles = (context) => {
  if (context.left.target !== null && !context.left.app) return () => false;
  const shipped = shippedBefore(context.baseline, context.right.app);
  return (file) => !shipped(file);
};

/**
 * The changed-file test of the rules that note what REA does not model in
 * new or changed code (RW-C05, RW-C06): `changedFiles`, except that every
 * module counts when REA could not analyze the old side of a component the
 * old release shipped. A file whose content the old release shipped, in
 * any component or under any path, did not change.
 */
export const unmodeledChanges = (context) =>
  context.left.app || context.left.target === null
    ? changedFiles(context)
    : () => true;

// What REA reported it could not examine in the new release: truncation,
// files at the per-file ceiling, failed files, no semantic graph.
const applicationGaps = (app) => {
  const { coverage } = app;
  const lines = [];
  if (coverage.semantic === "unavailable")
    lines.push(
      reported(
        "REA produced no semantic graph, so requests, processes and literals were not examined",
        "observed",
        APP_SOURCE,
      ),
    );
  if (coverage.graph_truncated || coverage.graph_omitted > 0)
    lines.push(
      reported(
        `Application graph truncated, ${coverage.graph_omitted} items omitted`,
        "observed",
        APP_SOURCE,
      ),
    );
  if (coverage.semantic_truncated || (coverage.semantic_omitted_nodes ?? 0) > 0)
    lines.push(
      reported(
        `Semantic graph truncated${coverage.semantic_omitted_nodes ? ` (${coverage.semantic_omitted_nodes} nodes omitted)` : ""}${coverage.semantic_limits.length > 0 ? `; REA's limits for this run: ${coverage.semantic_limits.join(", ")}` : ""}`,
        "observed",
        APP_SOURCE,
      ),
    );
  if ((coverage.semantic_unreached_modules ?? []).length > 0)
    lines.push(
      reported(
        `Script files with no semantic facts after REA's global node limit: ${listed(coverage.semantic_unreached_modules)}`,
        "derived",
        APP_SOURCE,
      ),
    );
  if (coverage.semantic_global_limit_reached)
    lines.push(
      reported(
        "REA reached its global node limit, so any analyzed file may have been examined only in part",
        "derived",
        APP_SOURCE,
      ),
    );
  if ((app.inlineScriptFiles ?? []).length > 0)
    lines.push(
      reported(
        `Pages with inline scripts REA does not analyze: ${listed(app.inlineScriptFiles)}`,
        "observed",
        APP_SOURCE,
      ),
    );
  if (coverage.semantic_ceiling_modules.length > 0)
    lines.push(
      reported(
        `Files that reached REA's per-file node ceiling: ${listed(coverage.semantic_ceiling_modules)}`,
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

// What a bundle's source map says changed: `{ known, changed }`, with the
// original sources added, changed or removed since the old bundle's map.
const originalChanges = (context, file) => {
  const oldFile = renamedFrom(context.aliases)(file) ?? file;
  const sourcesOf = (app, bundle) =>
    new Map(
      (app?.embeddedSources ?? [])
        .filter((fact) => fact.data.bundle === bundle)
        .map((fact) => [fact.data.original, fact.data.content_sha256]),
    );
  const before = sourcesOf(context.left.app, oldFile);
  const after = sourcesOf(context.right.app, file);
  if (before.size === 0 || after.size === 0)
    return { known: false, changed: [] };
  const changed = [
    ...[...after]
      .filter(([original, digest]) => before.get(original) !== digest)
      .map(([original]) => original),
    ...[...before.keys()].filter((original) => !after.has(original)),
  ];
  return { known: true, changed };
};

// Changed unexamined files, split by what their source maps say.
const unexaminedChanges = (context, files) => {
  const changes = files.map((file) => ({
    file,
    ...originalChanges(context, file),
  }));
  return {
    changes,
    substantive: changes.filter(
      (change) => !change.known || change.changed.length > 0,
    ),
  };
};

const sourceMapLines = (changes) =>
  changes
    .filter((change) => change.known)
    .map((change) =>
      reported(
        change.changed.length > 0
          ? `The source map of ${change.file} names ${change.changed.length} original source${change.changed.length === 1 ? "" : "s"} that changed: ${listed(change.changed)}`
          : `The source map of ${change.file} lists the same original sources with the same content as before`,
        "derived",
        COMPONENT,
      ),
    );

// The same file failed in the old release too, so higher limits may not help.
const failedBefore = (context, files) => {
  const old = new Set(
    (context.left.app?.analysisFailures ?? [])
      .map((failure) => failure.location?.file)
      .filter(Boolean),
  );
  return files.some((file) => old.has(file));
};

const recommendationFor = (context, { limited, changes }) => {
  const named = changes.filter((change) => change.changed.length > 0);
  const review =
    named.length > 0
      ? ` Start with the original sources the source map names as changed.`
      : "";
  if (
    failedBefore(
      context,
      changes.map((change) => change.file),
    )
  )
    return `REA could not examine these files in ${context.labels.left} either, so higher limits may not help; review them by other means.${review}`;
  return limited
    ? `Re-run with higher REA limits (--max-semantic-nodes-per-file, --max-heap-mb), or review the listed files by other means.${review}`
    : `Review the listed files or captures by other means.${review}`;
};

// Files REA examined only in part or not at all, or whose use of
// child_process it classified no process call for.
const unexaminedFiles = (app, processGaps) => [
  ...examinedInPart(app),
  ...processGaps.map((unknown) => unknown.data.module),
  ...(app.inlineScriptFiles ?? []),
];

/**
 * RW-C01: part of the new release was not examined. High when the
 * unexamined files changed since the old release, since a change there is
 * exactly what this report cannot see; medium otherwise.
 */
export const unexaminedAnalysis = (context) => {
  const app = context.right.app;
  const captureGaps = context.right.capture?.gaps ?? [];
  const processGaps = app ? processGapsOf(app, changedFiles(context)) : [];
  const evidence = [
    ...(app ? applicationGaps(app) : []),
    ...processGaps.slice(0, MAX_FILES).map(gapLine),
    ...captureGaps.map((gap) => reported(gap, "derived", COMPONENT)),
  ];
  if (evidence.length === 0) return [];
  const files = app ? unexaminedFiles(app, processGaps) : [];
  const changed = app ? [...new Set(files.filter(changedFiles(context)))] : [];
  const { changes, substantive } = unexaminedChanges(context, changed);
  const limited =
    app &&
    (app.coverage.semantic_truncated ||
      app.coverage.semantic_ceiling_modules.length > 0);
  const mapsOnly = changed.length > 0 && substantive.length === 0;
  return [
    {
      rule: "RW-C01",
      severity:
        substantive.length > 0 ||
        (app?.coverage.semantic === "unavailable" && context.left.app)
          ? "high"
          : "medium",
      title:
        changed.length > 0
          ? `Changed code in ${context.labels.right} was not examined`
          : `Analysis of ${context.labels.right} is incomplete`,
      summary:
        changed.length > 0
          ? `REA could not fully examine ${listed(changed)}, which changed since ${context.labels.left}; findings in the unexamined part are missing.`
          : `REA examined only part of ${context.labels.right}; findings in the unexamined part are missing from this report.`,
      why: "A pass is meaningful only for code that was examined. Large bundles are where injected code hides most easily.",
      recommendation: recommendationFor(context, { limited, changes }),
      evidence: [...evidence, ...sourceMapLines(changes)],
      unknowns: [
        "Release Watch cannot tell what the unexamined code does.",
        ...(mapsOnly
          ? [
              "The source maps say no original source changed, but REA does not establish that a map matches its bundle.",
            ]
          : []),
      ],
    },
  ];
};
