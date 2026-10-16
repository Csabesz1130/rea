// Orchestrates one release comparison: REA analysis of every component on
// both sides, the capability diff, policy evaluation and the report model.
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { credentialsIn } from "./catalog.mjs";
import { collectSide, emptyCollection } from "./collect.mjs";
import {
  ambiguousBundles,
  diffApplications,
  diffCaptures,
  moduleAliases,
} from "./diff.mjs";
import { discoverRelease } from "./discover.mjs";
import { deploymentOf } from "./facts/capture.mjs";
import { isScriptPath } from "./facts/modules.mjs";
import { pairComponents, pairHelpers, pairRuntimes } from "./pairing.mjs";
import { connectionTotals, registrationTotals } from "./rules/mcp.mjs";
import { releaseWindowPairing } from "./rules/window-pairing.mjs";
import {
  evaluateComponent,
  numberFindings,
  releaseBaseline,
  releaseMovesOf,
  verdictFor,
} from "./policy.mjs";
import { sourceText } from "./redact.mjs";
import { continuation, sourceLine } from "./source-line.mjs";
import { openSources } from "./sources.mjs";
import { surfaceNames, surfacesOf } from "./surfaces.mjs";

/** Two labels a reader can tell apart: equal versions gain "(old)" and "(new)". */
const distinct = (left, right) =>
  left === right
    ? { left: `${left} (old)`, right: `${right} (new)` }
    : { left, right };

const versionLabel = (side, fallback) =>
  side.app?.package?.version ? `v${side.app.package.version}` : fallback;

// A release is named by its manifest version, else the first component
// package version, else its path's base name when the two differ, else
// "old" and "new".
const releaseLabels = (leftRelease, rightRelease, collected) => {
  const version = (release, side) => {
    if (release.version) return `v${release.version}`;
    const found = collected
      .map((component) => component[side].app?.package?.version)
      .find(Boolean);
    return found ? `v${found}` : null;
  };
  const names = [
    path.basename(leftRelease.root),
    path.basename(rightRelease.root),
  ];
  const distinctNames = names[0] !== names[1];
  return distinct(
    version(leftRelease, "left") ?? (distinctNames ? names[0] : "old"),
    version(rightRelease, "right") ?? (distinctNames ? names[1] : "new"),
  );
};

// REA's module pairing reads both application Evidence records in full; past
// this size it costs more than the renames it finds.
const MAX_COMPARISON_INPUT = 64 * 1024 * 1024;

const scriptsOf = (app) =>
  new Set(app.assets.map((asset) => asset.key).filter(isScriptPath));

// Whether REA's pairing can change anything: some script exists only on the
// old side and some only on the new side.
const mayHaveRenames = (left, right) => {
  const before = scriptsOf(left.app);
  const after = scriptsOf(right.app);
  return (
    [...before].some((key) => !after.has(key)) &&
    [...after].some((key) => !before.has(key))
  );
};

const comparisonSkip = (mode, left, right) => {
  if (mode === "never") return "disabled";
  if (mode === "always") return null;
  if (!mayHaveRenames(left, right)) return "no-renames";
  const size = statSync(left.appFile).size + statSync(right.appFile).size;
  return size > MAX_COMPARISON_INPUT ? "size" : null;
};

// REA compares two application graphs; its input is assembled from the two
// saved Evidence files without re-serializing them.
const reaComparison = async ({ rea, component, left, right, outDir, mode }) => {
  if (left.appFile === null || right.appFile === null) return null;
  const skipped = comparisonSkip(mode, left, right);
  if (skipped !== null) return { skipped, pairs: [] };
  const input = path.join(
    outDir,
    "evidence",
    `${component}-compare-input.json`,
  );
  writeFileSync(
    input,
    Buffer.concat([
      Buffer.from('{"left":'),
      readFileSync(left.appFile),
      Buffer.from(',"right":'),
      readFileSync(right.appFile),
      Buffer.from("}"),
    ]),
  );
  const file = path.join(outDir, "evidence", `${component}-comparison.json`);
  const result = await rea.run("compare-application-versions", [input], {
    label: `compare ${component}`,
    saveTo: file,
  });
  rmSync(input, { force: true });
  if (!result.ok) return { error: result.error, pairs: [] };
  const comparison = result.evidence.normalized_result;
  const nodes = new Map(
    comparison.graph.nodes.map((node) => [node.node_id, node]),
  );
  const pathOf = (id) =>
    nodes.get(id)?.observations?.[0]?.properties?.path ?? null;
  // Assets with equal content share one node, so a renamed file is paired on
  // its module item; both kinds are read.
  const pairs = comparison.items
    .filter(
      (item) =>
        (item.node_kind === "javascript-asset" ||
          item.node_kind === "javascript-module") &&
        item.match?.status === "matched",
    )
    .map((item) => ({
      left: pathOf(item.left_node_id),
      right: pathOf(item.right_node_id),
      basis: item.match.basis,
    }))
    .filter((pair) => pair.left !== null && pair.right !== null);
  return {
    evidence_id: result.evidence.evidence_id,
    summary: comparison.summary,
    limitations: comparison.limitations ?? [],
    file: path.relative(outDir, file),
    pairs,
  };
};

// Lines where REA reported a string or resolved URL holding a key.
const sensitiveLines = (app) =>
  new Set(
    [...app.stringLiterals, ...app.endpoints]
      // A whole-literal credential is also found inside the literal.
      .filter((fact) => credentialsIn(fact.data.value).length > 0)
      .flatMap((fact) => {
        // A key in a multi-line literal marks every line of it.
        const first = fact.location?.line;
        const last = fact.data.range?.end?.line ?? first;
        return Array.from(
          { length: Math.max(1, last - first + 1) },
          (_value, offset) => `${fact.location?.file}:${first + offset}`,
        );
      }),
  );

// How many lines on a sensitive line's expression may carry its value.
const CHAIN = 4;

// Whether a source line is shown as sensitive: REA reported a key on it, it
// starts inside a string continued from the line before (what that string
// holds is not on it), or it carries on the expression of a reported line
// through `+`, `,`, `[`, `(` or a template literal, at most CHAIN lines on.
const sensitiveAt = (sources, [file, line], reported) => {
  if (reported.has(`${file}:${line}`)) return true;
  const text = (at) => sources.lineAt(file, at)?.text ?? "";
  if (continuation(text(line - 1)).escaped) return true;
  for (let start = line - 1; start >= Math.max(1, line - CHAIN); start -= 1) {
    if (!reported.has(`${file}:${start}`)) continue;
    let state = { template: false };
    let carried = true;
    for (let at = start; at < line && carried; at += 1) {
      state = continuation(text(at), state.template);
      carried = state.escaped || state.template || state.operand;
    }
    if (carried) return true;
  }
  return false;
};

// Source lines for display, attached only to evidence located in this side's
// release and verified against REA's digest when one was recorded.
const attachSources = (findings, side, sources, sideName) => {
  if (sources === null) return;
  const digests = new Set(side.app.assets.map((asset) => asset.data.sha256));
  const sensitive = sensitiveLines(side.app);
  for (const finding of findings) {
    const shown = new Set();
    for (const item of finding.evidence) {
      if (item.side !== sideName || item.snippet || !item.location?.line)
        continue;
      const { file, line, column } = item.location;
      const where = `${file}:${line}`;
      if (shown.has(where)) continue;
      if (item.artifact_sha256 !== null && !digests.has(item.artifact_sha256))
        continue;
      const snippet = sources.lineAt(file, line);
      if (snippet === null) continue;
      item.snippet = {
        line: snippet.line,
        text: sourceText(
          sourceLine(snippet.text, column ?? 0, {
            sensitive: sensitiveAt(sources, [file, line], sensitive),
            file,
          }),
        ),
        verified: snippet.verified,
        release: side.label,
      };
      shown.add(where);
    }
  }
};

const openSide = (rea, side) => {
  if (!side.app || !side.target?.app) return Promise.resolve(null);
  const assets = new Map(
    side.app.assets.map((asset) => [asset.key, asset.data.sha256]),
  );
  return openSources(rea, side.target.app, assets, side.label);
};

// Collect both sides of one component, in parallel unless jobs is 1.
const collectComponent = async ({
  name,
  leftTarget,
  rightTarget,
  rea,
  outDir,
  options,
  errors,
}) => {
  const collect = (side, target) =>
    target === null
      ? Promise.resolve(emptyCollection())
      : collectSide({
          rea,
          component: name,
          side,
          label: `${name} ${side === "left" ? "old" : "new"}`,
          target,
          outDir,
          errors,
          analysisArgs: options.analysisArgs ?? [],
        });
  if (options.jobs === 1) {
    const left = await collect("left", leftTarget);
    return { name, left, right: await collect("right", rightTarget) };
  }
  const [left, right] = await Promise.all([
    collect("left", leftTarget),
    collect("right", rightTarget),
  ]);
  return { name, left, right };
};

// A side failed when its target was analyzable but REA produced no facts.
const failed = (side) =>
  side.target !== null && side.target.app !== null && side.app === null;
const captureFailed = (side) =>
  side.target !== null && side.target.capture !== null && side.capture === null;

// Labels, surfaces, REA pairing and the diff of one collected component.
const prepareComponent = async ({
  collected,
  releaseLabels: labelsOfRelease,
  rea,
  outDir,
  options,
}) => {
  const { name } = collected;
  const labels = distinct(
    versionLabel(collected.left, labelsOfRelease.left),
    versionLabel(collected.right, labelsOfRelease.right),
  );
  const left = { ...collected.left, label: labels.left };
  const right = { ...collected.right, label: labels.right };
  left.surfaces = surfacesOf(left);
  right.surfaces = surfacesOf(right);
  const comparison = await reaComparison({
    rea,
    component: name,
    left,
    right,
    outDir,
    mode: options.reaCompare ?? "auto",
  });
  const aliases = moduleAliases(left.app, right.app, comparison?.pairs ?? []);
  const deployment = deploymentOf(
    left.capture,
    right.capture,
    options.vendorDomains ?? [],
  );
  const diff = {
    app: diffApplications(left.app, right.app, aliases, {
      leftKnown: !failed(left),
    }),
    runtimes: pairRuntimes(left, right),
    helpers: pairHelpers(left, right),
    capture: diffCaptures(left.capture, right.capture),
  };
  return {
    name,
    renamed: collected.renamed,
    left,
    right,
    deployment,
    labels,
    comparison,
    aliases,
    diff,
  };
};

/**
 * What the whole release gained and lost, so a site that moved between
 * components is recognised as a move, and how many tool-to-process
 * connections each capability has on each side.
 */
const releaseContext = (prepared) => ({
  moves: releaseMovesOf(
    prepared.map((component) => ({
      name: component.name,
      diff: component.diff,
      comparable: !failed(component.right),
      left: component.left,
      right: component.right,
    })),
  ),
  // A component whose new side REA could not analyze is left out: its old
  // tools are unknown now, not gone.
  connections: connectionTotals(
    comparable(prepared).map((component) => component.left.app),
    comparable(prepared).map((component) => component.right.app),
  ),
  registrations: registrationTotals(
    comparable(prepared).map((component) => component.left.app),
    comparable(prepared).map((component) => component.right.app),
  ),
  windows: releaseWindowPairing(prepared),
});

const comparable = (prepared) =>
  prepared.filter((component) => !failed(component.right));

// Grade one prepared component and attach source lines.
const gradeComponent = async ({
  component,
  release,
  releaseLabels: labelsOfRelease,
  baseline,
  rea,
  options,
}) => {
  const { name, left, right, labels, comparison, aliases, diff, deployment } =
    component;
  const [rightSources, leftSources] = await Promise.all([
    openSide(rea, right),
    openSide(rea, left),
  ]);
  const { findings, network } = evaluateComponent({
    name,
    left,
    right,
    comparison,
    diff,
    deployment,
    aliases,
    ambiguous: ambiguousBundles(left.app, right.app, aliases),
    baseline,
    release,
    surfaces: surfaceNames(left.surfaces, right.surfaces),
    options,
    labels,
    releaseLabels: labelsOfRelease,
    // Without an analyzed old side every fact would look new, so only
    // coverage is graded and the analysis error decides the verdict.
    coverageOnly: failed(left),
    // Without a readable old capture, runtime facts cannot be compared.
    captureBaselineFailed: captureFailed(left),
  });
  try {
    attachSources(findings, right, rightSources, "right");
    attachSources(findings, left, leftSources, "left");
  } finally {
    rightSources?.close();
    leftSources?.close();
  }
  return {
    ...component,
    surfaces: surfaceNames(left.surfaces, right.surfaces),
    network,
    findings,
  };
};

// The manifest's product, else a component's package name, else the new
// release's directory name unless that already is a release label.
const productName = (rightRelease, components, labels) => {
  const named =
    rightRelease.product ??
    components
      .map(
        (component) =>
          component.right.app?.package?.name ??
          component.left.app?.package?.name,
      )
      .find(Boolean);
  if (named) return named;
  const directory = path.basename(rightRelease.root);
  return directory === labels.right || directory === labels.left
    ? null
    : directory;
};

/** Compare two releases and return the complete report model. */
export const compareReleases = async ({
  left,
  right,
  outDir,
  rea,
  options,
}) => {
  const started = performance.now();
  mkdirSync(path.join(outDir, "evidence"), { recursive: true });
  const leftRelease = discoverRelease(left, {
    capture: options.leftCapture ?? null,
  });
  const rightRelease = discoverRelease(right, {
    capture: options.rightCapture ?? null,
  });
  const errors = [];
  // Components are collected one after another, each with its two sides in
  // parallel, then graded against what the whole old release contained.
  const pairs = pairComponents(leftRelease, rightRelease);
  const collected = [];
  for (const pair of pairs)
    collected.push({
      ...(await collectComponent({ ...pair, rea, outDir, options, errors })),
      renamed: pair.renamed,
    });
  const labels = releaseLabels(leftRelease, rightRelease, collected);
  const baseline = releaseBaseline(
    collected.map((component) => component.left),
  );
  const prepared = [];
  for (const component of collected)
    prepared.push(
      await prepareComponent({
        collected: component,
        releaseLabels: labels,
        rea,
        outDir,
        options,
      }),
    );
  const release = releaseContext(prepared);
  const components = [];
  for (const component of prepared)
    components.push(
      await gradeComponent({
        component,
        release,
        releaseLabels: labels,
        baseline,
        rea,
        options,
      }),
    );
  const findings = numberFindings(
    components.flatMap((component) => component.findings),
  );
  return {
    tool: { name: "Release Watch", version: "0.2.0" },
    generated_at: new Date().toISOString(),
    product: productName(rightRelease, components, labels),
    labels,
    components,
    findings,
    verdict: verdictFor(findings, options.failOn, { errors }),
    errors,
    run: {
      elapsed_ms: Math.round(performance.now() - started),
      rea_calls: rea.calls,
      llm_tokens: 0,
    },
  };
};
