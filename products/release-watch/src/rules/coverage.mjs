// Coverage rules: what REA or Release Watch could not examine. A rule that
// found nothing only means something when the code was examined, so limits
// on the new side become findings instead of a silent pass.
import path from "node:path";

import { SECURITY_HEADERS, isHttpClient, packageNameOf } from "../catalog.mjs";
import { captureUnread } from "../facts/capture.mjs";
import { displayPath } from "../urls.mjs";
import {
  MAX_FILES,
  changedFiles,
  incompleteAnalysis,
} from "./analysis-coverage.mjs";
import {
  APP_SOURCE,
  cite,
  heuristic,
  packResult,
  reported,
} from "./shared.mjs";

const COMPONENT = "Release Watch";
const FUSE_SOURCE = "REA inspect_electron_fuses";

// An unread capture, by its side's label and its file name; a capture
// compared on its own is labelled by its file name already.
const unreadCapture = (side, label) => {
  const name = path.basename(side.target.capture);
  return label === name ? name : `the capture given for ${label} (${name})`;
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

// Why runtime facts were not compared: a capture REA could not read, or,
// for a component both releases have, a capture given for one side only.
const captureLines = ({ left, right, labels }) => {
  const unread = [
    ...(captureUnread(left)
      ? [
          `REA could not read ${unreadCapture(left, labels.left)}, so runtime findings were not compared.`,
        ]
      : []),
    ...(captureUnread(right)
      ? [
          `REA could not read ${unreadCapture(right, labels.right)}, so runtime rules did not run for ${labels.right}.`,
        ]
      : []),
  ];
  if (
    unread.length > 0 ||
    left.target === null ||
    right.target === null ||
    (left.capture === null) === (right.capture === null)
  )
    return unread;
  return [
    left.capture
      ? `Only ${labels.left} has a runtime capture, so runtime rules did not run for ${labels.right}.`
      : `Only ${labels.right} has a runtime capture, so header and cookie changes were not compared.`,
  ];
};

// RW-C02: pieces that could only be seen on one side, so nothing was compared.
const oneSided = (context) => {
  const { left, right, labels, comparison, name } = context;
  const release = context.releaseLabels ?? labels;
  const lines = [];
  if (left.target === null)
    lines.push(
      `Component ${name} is new in ${release.right}; its hosts, packages, SDKs, keys, windows and moved code were compared with all of ${release.left}, and everything else in it is reported as new.`,
    );
  if (right.target === null)
    lines.push(
      `Component ${name} is missing from ${release.right}; nothing in it was compared.`,
    );
  lines.push(...captureLines(context));
  for (const page of unmatchedPages(context))
    lines.push(
      `The ${labels.right} capture has no page at ${page} to compare with ${labels.left}'s security headers.`,
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
 * RW-C05: new or changed modules that import an HTTP client library, or a
 * local module that does, and have no request site REA recognised. Their
 * requests are not examined by the network or AI rules. Medium unless a
 * runtime capture of the new release covers what they send.
 */
const unmodeledClients = (context) => {
  const app = context.right.app;
  if (!app) return [];
  const requesting = new Set(
    app.requests.map((request) => request.data.module),
  );
  const direct = app.imports.filter((fact) =>
    isHttpClient(packageNameOf(fact.key)),
  );
  const clientModules = new Map(
    direct.map((fact) => [fact.data.module, packageNameOf(fact.key)]),
  );
  const before = new Set(
    (context.left.app?.imports ?? [])
      .filter((fact) => isHttpClient(packageNameOf(fact.key)))
      .map((fact) => `${fact.data.module}#${fact.key}`),
  );
  // New imports, and modules that changed although they imported the
  // client before: their requests may be new too. Without an analyzed old
  // side, every module counts.
  const changed = context.left.app ? changedFiles(context) : () => true;
  const fresh = [
    ...direct
      .filter(
        (fact) =>
          !before.has(`${fact.data.module}#${fact.key}`) ||
          changed(fact.data.module),
      )
      .map((fact) => ({
        module: fact.data.module,
        client: packageNameOf(fact.key),
        line: cite(`${fact.data.module} imports ${fact.key}`, fact, APP_SOURCE),
      })),
    // A changed module that calls through a client another module set up.
    ...[...app.modules]
      .filter(([module]) => !clientModules.has(module) && changed(module))
      .flatMap(([module, entry]) =>
        [...entry.local]
          .filter((target) => clientModules.has(target))
          .slice(0, 1)
          .map((target) => ({
            module,
            client: clientModules.get(target),
            line: heuristic(
              `${module} changed and imports ${target}, which imports ${clientModules.get(target)}`,
              { file: module, line: null, column: null },
            ),
          })),
      ),
  ].filter((site) => !requesting.has(site.module));
  if (fresh.length === 0) return [];
  const clients = [...new Set(fresh.map((site) => site.client))];
  const moduleCount = new Set(fresh.map((site) => site.module)).size;
  const captured = context.right.capture !== null;
  return [
    {
      rule: "RW-C05",
      severity: captured ? "low" : "medium",
      title: `Requests through ${clients.join(", ")} in new or changed code are not examined`,
      summary: `${moduleCount} new or changed module${moduleCount === 1 ? "" : "s"} of ${context.labels.right} reach${moduleCount === 1 ? "es" : ""} an HTTP client library and REA recognised no request site in ${moduleCount === 1 ? "it" : "them"}.`,
      why: "Destinations reached through these libraries, AI provider APIs among them, are invisible to the network and AI rules, so a new third-party host there would not be reported.",
      recommendation: captured
        ? "The runtime capture covers what the release sent while it was recorded; review these modules' requests for paths the capture did not exercise."
        : "Capture the release's traffic with release-watch record, or review these modules' requests.",
      evidence: [
        ...fresh.slice(0, MAX_FILES).map((site) => site.line),
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
