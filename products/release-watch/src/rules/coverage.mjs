// Coverage rules: what REA or Release Watch could not examine. A rule that
// found nothing only means something when the code was examined, so limits
// on the new side become findings instead of a silent pass.
import { SECURITY_HEADERS, isHttpClient, packageNameOf } from "../catalog.mjs";
import { displayPath } from "../urls.mjs";
import {
  APP_SOURCE,
  cite,
  heuristic,
  packResult,
  reported,
} from "./shared.mjs";

const COMPONENT = "Release Watch";
const FUSE_SOURCE = "REA inspect_electron_fuses";
const MAX_FILES = 6;

const listed = (files) =>
  `${files.slice(0, MAX_FILES).join(", ")}${files.length > MAX_FILES ? ` and ${files.length - MAX_FILES} more` : ""}`;

// Files whose content differs from the old release, or that are new there.
// Unknown without an analyzed old side: nothing is called changed then.
const changedFiles = (context) => {
  if (!context.left.app) return () => false;
  const before = new Map(
    (context.left.app?.assets ?? []).map((asset) => [
      asset.key,
      asset.data.sha256,
    ]),
  );
  const renamed = new Map(
    [...context.aliases].map(([from, alias]) => [alias.path, from]),
  );
  return (file) => {
    const old = before.get(file) ?? before.get(renamed.get(file));
    const now = context.right.app.assets.find((asset) => asset.key === file)
      ?.data.sha256;
    return old === undefined || old !== now;
  };
};

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
        `Semantic graph truncated${coverage.semantic_omitted_nodes ? ` (${coverage.semantic_omitted_nodes} nodes omitted)` : ""}${coverage.semantic_limits.length > 0 ? ` at ${coverage.semantic_limits.join(", ")}` : ""}`,
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

/**
 * RW-C01: part of the new release was not examined. High when the
 * unexamined files changed since the old release, since a change there is
 * exactly what this report cannot see; medium otherwise.
 */
const incompleteAnalysis = (context) => {
  const app = context.right.app;
  const captureGaps = context.right.capture?.gaps ?? [];
  const evidence = [
    ...(app ? applicationGaps(app) : []),
    ...captureGaps.map((gap) => reported(gap, "derived", COMPONENT)),
  ];
  if (evidence.length === 0) return [];
  const files = app
    ? [
        ...app.coverage.semantic_ceiling_modules,
        ...(app.coverage.semantic_unreached_modules ?? []),
        ...app.analysisFailures
          .map((failure) => failure.location?.file)
          .filter(Boolean),
      ]
    : [];
  const changed = app ? [...new Set(files.filter(changedFiles(context)))] : [];
  const limited =
    app &&
    (app.coverage.semantic_truncated ||
      app.coverage.semantic_ceiling_modules.length > 0);
  return [
    {
      rule: "RW-C01",
      severity:
        changed.length > 0 ||
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
      recommendation: limited
        ? "Re-run with higher REA limits (--max-semantic-nodes-per-file, --max-heap-mb), or review the listed files by other means."
        : "Review the listed files or captures by other means.",
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
        .map(
          (item) =>
            item.left[0].data.display_path ??
            displayPath(item.left[0].data.path),
        )
    : [];

const COMPARISON_LINES = {
  size: "REA's module pairing was skipped because the Evidence is larger than 64 MB; a renamed module may be reported as new code.",
};

// RW-C02: pieces that could only be seen on one side, so nothing was compared.
const oneSided = (context) => {
  const { left, right, labels, comparison, name } = context;
  const release = context.releaseLabels ?? labels;
  const lines = [];
  if (left.target === null)
    lines.push(
      `Component ${name} is new in ${release.right}; it was compared with every component of ${release.left} together.`,
    );
  if (right.target === null)
    lines.push(
      `Component ${name} is missing from ${release.right}; nothing in it was compared.`,
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
  if (context.captureBaselineFailed)
    lines.push(
      `REA could not read ${labels.left}'s capture, so runtime findings were not compared.`,
    );
  for (const path of unmatchedPages(context))
    lines.push(
      `The ${labels.right} capture has no page at ${path} to compare with ${labels.left}'s security headers.`,
    );
  if (comparison?.error)
    lines.push(
      `REA could not pair renamed modules (${comparison.error.code ?? "error"}); a renamed bundle may be reported as new code.`,
    );
  if (COMPARISON_LINES[comparison?.skipped])
    lines.push(COMPARISON_LINES[comparison.skipped]);
  if (
    left.runtimes.some(
      (runtime) => runtime.fuses && !runtime.fuses.ambiguous,
    ) &&
    right.target &&
    right.target.kind !== "electron-dist"
  )
    lines.push(
      `Fuses were not compared: ${labels.right} is a ${right.target.kind}, not an Electron distribution with executables.`,
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

// Why the new side's fuses are not readable, from how the inspection ended.
const fuseGapLines = (context) => {
  const { right, labels } = context;
  const status = right.runtimeStatus;
  if (status.candidates === 0)
    return [
      reported(
        `${labels.right} has no executable at its root for REA to inspect`,
        "derived",
        COMPONENT,
      ),
    ];
  const lines = status.failures.map((failure) =>
    reported(
      `REA's fuse inspection of ${failure.name} failed: ${failure.code ?? failure.message ?? "error"}`,
      "observed",
      FUSE_SOURCE,
    ),
  );
  if (right.runtimes.length === 0 && status.failures.length < status.candidates)
    lines.push(
      reported(
        `REA found no fuse wire in ${labels.right}'s root executables`,
        "observed",
        FUSE_SOURCE,
      ),
    );
  for (const pair of context.diff.runtimes) {
    if (
      !pair.after?.fuses ||
      !pair.before?.fuses ||
      pair.before.fuses.ambiguous
    )
      continue;
    if (pair.after.fuses.ambiguous)
      lines.push(
        reported(
          `REA found ${pair.after.fuses.sentinel_count} fuse wires in ${pair.after.name}, so no fuse state is established`,
          "observed",
          FUSE_SOURCE,
        ),
      );
    else
      for (const change of pair.changes.filter(
        (row) => row.after !== "enabled" && row.after !== "disabled",
      ))
        lines.push(
          reported(
            `${pair.after.name} ${change.name}: ${change.before} → ${change.after}`,
            "observed",
            FUSE_SOURCE,
          ),
        );
  }
  return lines;
};

// RW-C03: the old release had readable fuses and the new one does not.
const fuseCoverage = (context) => {
  const readable = context.left.runtimes.some(
    (runtime) => runtime.fuses && !runtime.fuses.ambiguous,
  );
  if (!readable || context.right.target?.kind !== "electron-dist") return [];
  const evidence = fuseGapLines(context);
  if (evidence.length === 0) return [];
  return [
    {
      rule: "RW-C03",
      severity: "medium",
      title: `Electron fuse state unknown in ${context.labels.right}`,
      summary: `${context.labels.left}'s fuses were readable; some of ${context.labels.right}'s are not, so fuse regressions cannot be ruled out.`,
      why: "Fuses block well-known ways to run code inside a signed app; an unreadable wire may hide a regression.",
      recommendation:
        "Inspect the new executable's fuses with @electron/fuses or ask the vendor for the build configuration.",
      evidence,
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

/**
 * RW-C05: modules that import an HTTP client library and have no request
 * site REA recognised. Their requests are not examined by the network rules.
 */
const unmodeledClients = (context) => {
  const app = context.right.app;
  if (!app) return [];
  const requesting = new Set(
    app.requests.map((request) => request.data.module),
  );
  const sites = app.imports.filter(
    (fact) =>
      isHttpClient(packageNameOf(fact.key)) &&
      !requesting.has(fact.data.module),
  );
  const before = new Set(
    (context.left.app?.imports ?? [])
      .filter((fact) => isHttpClient(packageNameOf(fact.key)))
      .map((fact) => `${fact.data.module}#${fact.key}`),
  );
  // New imports, and modules that changed although they imported the
  // client before: their requests may be new too.
  const changed = context.left.app ? changedFiles(context) : () => true;
  const fresh = sites.filter(
    (fact) =>
      !before.has(`${fact.data.module}#${fact.key}`) ||
      changed(fact.data.module),
  );
  if (fresh.length === 0) return [];
  const clients = [...new Set(fresh.map((fact) => packageNameOf(fact.key)))];
  const moduleCount = new Set(fresh.map((fact) => fact.data.module)).size;
  return [
    {
      rule: "RW-C05",
      severity: "low",
      title: `Requests through ${clients.join(", ")} in new or changed code are not examined`,
      summary: `${moduleCount} module${moduleCount === 1 ? "" : "s"} of ${context.labels.right} import${moduleCount === 1 ? "s" : ""} an HTTP client library and REA recognised no request site in ${moduleCount === 1 ? "it" : "them"}.`,
      why: "Destinations reached through these libraries are invisible to the network rules, so a new third-party host there would not be reported.",
      recommendation:
        "Capture the release's traffic with release-watch record, or review these modules' requests.",
      evidence: [
        ...fresh
          .slice(0, MAX_FILES)
          .map((fact) =>
            cite(`${fact.data.module} imports ${fact.key}`, fact, APP_SOURCE),
          ),
        heuristic(
          "Release Watch lists HTTP client packages whose calls REA's request extraction may not model",
        ),
      ],
      unknowns: [],
    },
  ];
};

/** Coverage rules. */
export const coveragePack = (context) =>
  packResult([
    ...incompleteAnalysis(context),
    ...oneSided(context),
    ...fuseCoverage(context),
    ...helperCoverage(context),
    ...unmodeledClients(context),
  ]);
