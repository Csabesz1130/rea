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

import { collectSide } from "./collect.mjs";
import {
  diffApplications,
  diffCaptures,
  diffFuses,
  diffGo,
  ambiguousBundles,
  moduleAliases,
} from "./diff.mjs";
import { discoverRelease } from "./discover.mjs";
import {
  evaluateComponent,
  numberFindings,
  releaseBaseline,
  verdictFor,
} from "./policy.mjs";
import { printable, scrubText } from "./redact.mjs";
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
  new Set(
    app.assets
      .map((asset) => asset.key)
      .filter((key) => /\.(m?js|cjs)$/.test(key)),
  );

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

const pairHelpers = (left, right) => {
  const relatives = [
    ...new Set(
      [...left.helpers, ...right.helpers].map((helper) => helper.relative),
    ),
  ];
  return relatives.sort().map((relative) => {
    const before =
      left.helpers.find((helper) => helper.relative === relative) ?? null;
    const after =
      right.helpers.find((helper) => helper.relative === relative) ?? null;
    return {
      relative,
      name: path.basename(relative),
      before,
      after,
      go: before?.go && after?.go ? diffGo(before.go, after.go) : null,
    };
  });
};

const MAX_LINE = 180;
const LEAD = 60;

// One source line for display: scrubbed as a whole first, so no window can
// keep part of a credential, then cut to a window around the cited column.
const displayLine = (text, column) => {
  const scrubbed = printable(scrubText(text));
  if (scrubbed.length <= MAX_LINE) return scrubbed.trim();
  const position = scrubText(text.slice(0, column ?? 0)).length;
  const start = Math.max(
    0,
    Math.min(position - LEAD, scrubbed.length - MAX_LINE),
  );
  return `${start > 0 ? "…" : ""}${scrubbed.slice(start, start + MAX_LINE).trim()}…`;
};

// Source lines for display, attached only to evidence located in this side's
// release and verified against REA's digest when one was recorded.
const attachSources = (findings, side, sources, sideName) => {
  if (sources === null) return;
  const digests = new Set(side.app.assets.map((asset) => asset.data.sha256));
  for (const finding of findings) {
    const shown = new Set();
    for (const item of finding.evidence) {
      if (item.side !== sideName || item.snippet || !item.location?.line)
        continue;
      const where = `${item.location.file}:${item.location.line}`;
      if (shown.has(where)) continue;
      if (item.artifact_sha256 !== null && !digests.has(item.artifact_sha256))
        continue;
      const snippet = sources.lineAt(item.location.file, item.location.line);
      if (snippet === null) continue;
      item.snippet = {
        line: snippet.line,
        text: displayLine(snippet.text, item.location.column),
        verified: snippet.verified,
        release: side.label,
      };
      shown.add(where);
    }
  }
};

const openSide = (rea, side) => {
  if (!side.app || side.target.app === null) return Promise.resolve(null);
  const assets = new Map(
    side.app.assets.map((asset) => [asset.key, asset.data.sha256]),
  );
  return openSources(rea, side.target.app, assets, side.label);
};

const emptySide = () => ({
  target: null,
  app: null,
  appFile: null,
  appEvidence: null,
  runtime: null,
  helpers: [],
  capture: null,
  surfaces: { electron: [], web: [], ai: [], mcp: [] },
});

// Collect both sides of one component. Sides run in parallel.
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
      ? Promise.resolve(emptySide())
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
  const [left, right] = await Promise.all([
    collect("left", leftTarget),
    collect("right", rightTarget),
  ]);
  return { name, left, right };
};

// A component side is named by its own package version, else the release's
// label; a side the release does not have is "absent".
const sideLabels = (collected, releaseLabels) => {
  const label = (side, fallback) =>
    side.target === null ? "absent" : versionLabel(side, fallback);
  return distinct(
    label(collected.left, releaseLabels.left),
    label(collected.right, releaseLabels.right),
  );
};

// Compare and grade one collected component against the release baseline.
const finishComponent = async ({
  collected,
  releaseLabels,
  baseline,
  rea,
  outDir,
  options,
}) => {
  const { name } = collected;
  const labels = sideLabels(collected, releaseLabels);
  const left = { ...collected.left, label: labels.left };
  const right = { ...collected.right, label: labels.right };
  left.surfaces = surfacesOf(left);
  right.surfaces = surfacesOf(right);
  const [comparison, rightSources, leftSources] = await Promise.all([
    reaComparison({
      rea,
      component: name,
      left,
      right,
      outDir,
      mode: options.reaCompare ?? "auto",
    }),
    openSide(rea, right),
    openSide(rea, left),
  ]);
  const aliases = moduleAliases(left.app, right.app, comparison?.pairs ?? []);
  const diff = {
    app: diffApplications(left.app, right.app, aliases),
    fuses: diffFuses(left.runtime?.fuses ?? null, right.runtime?.fuses ?? null),
    helpers: pairHelpers(left, right),
    capture: diffCaptures(left.capture, right.capture),
  };
  const surfaces = surfaceNames(left.surfaces, right.surfaces);
  const { findings, network } = evaluateComponent({
    name,
    left,
    right,
    comparison,
    diff,
    aliases,
    ambiguous: ambiguousBundles(left.app, right.app, aliases),
    baseline,
    surfaces,
    options,
    labels,
    releaseLabels,
  });
  try {
    attachSources(findings, right, rightSources, "right");
    attachSources(findings, left, leftSources, "left");
  } finally {
    rightSources?.close();
    leftSources?.close();
  }
  return {
    name,
    left,
    right,
    comparison,
    diff,
    surfaces,
    aliases,
    network,
    findings,
  };
};

const pairComponents = (leftRelease, rightRelease) => {
  const names = [
    ...rightRelease.components.map((component) => component.name),
    ...leftRelease.components.map((component) => component.name),
  ].filter((name, index, all) => all.indexOf(name) === index);
  const targetOf = (release, name) =>
    release.components.find((component) => component.name === name)?.target ??
    null;
  return names.map((name) => ({
    name,
    leftTarget: targetOf(leftRelease, name),
    rightTarget: targetOf(rightRelease, name),
  }));
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
  const collected = [];
  for (const pair of pairComponents(leftRelease, rightRelease))
    collected.push(
      await collectComponent({ ...pair, rea, outDir, options, errors }),
    );
  const labels = releaseLabels(leftRelease, rightRelease, collected);
  const baseline = releaseBaseline(
    collected.map((component) => component.left),
  );
  const components = [];
  for (const component of collected)
    components.push(
      await finishComponent({
        collected: component,
        releaseLabels: labels,
        baseline,
        rea,
        outDir,
        options,
      }),
    );
  const findings = numberFindings(
    components.flatMap((component) => component.findings),
  );
  return {
    tool: { name: "Release Watch", version: "0.2.0" },
    generated_at: new Date().toISOString(),
    product:
      rightRelease.product ??
      components
        .map(
          (component) =>
            component.right.app?.package?.name ??
            component.left.app?.package?.name,
        )
        .find(Boolean) ??
      path.basename(rightRelease.root),
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
