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

import { credentialOf, credentialsIn } from "./catalog.mjs";
import { collectSide, emptyCollection } from "./collect.mjs";
import {
  ambiguousBundles,
  diffApplications,
  diffCaptures,
  diffFuses,
  diffGo,
  isScriptPath,
  moduleAliases,
} from "./diff.mjs";
import { discoverRelease } from "./discover.mjs";
import {
  evaluateComponent,
  numberFindings,
  releaseBaseline,
  verdictFor,
} from "./policy.mjs";
import { printable, scrubSource } from "./redact.mjs";
import { openSources } from "./sources.mjs";
import { surfaceNames, surfacesOf } from "./surfaces.mjs";
import { maskTag } from "./urls.mjs";

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

// Pair items by a key, then pair what is left by a fallback key when it is
// unique on both sides.
const pairBy = (before, after, key, fallback) => {
  const pairs = [];
  const unmatchedAfter = new Set(after);
  const unmatchedBefore = [];
  for (const item of before) {
    const match = after.find(
      (candidate) =>
        unmatchedAfter.has(candidate) && key(candidate) === key(item),
    );
    if (match) {
      unmatchedAfter.delete(match);
      pairs.push([item, match]);
    } else unmatchedBefore.push(item);
  }
  for (const item of unmatchedBefore) {
    const sameBefore = unmatchedBefore.filter(
      (other) => fallback(other) === fallback(item),
    );
    const candidates = [...unmatchedAfter].filter(
      (candidate) => fallback(candidate) === fallback(item),
    );
    if (
      fallback(item) !== null &&
      sameBefore.length === 1 &&
      candidates.length === 1
    ) {
      unmatchedAfter.delete(candidates[0]);
      pairs.push([item, candidates[0]]);
    } else pairs.push([item, null]);
  }
  return [...pairs, ...[...unmatchedAfter].map((item) => [null, item])];
};

// Helpers pair by relative path, then by file name when it is unique, so a
// helper that moved directory is compared with its old build.
export const pairHelpers = (left, right) =>
  pairBy(
    left.helpers,
    right.helpers,
    (helper) => helper.relative,
    (helper) => helper.name,
  )
    .map(([before, after]) => ({
      relative: (after ?? before).relative,
      name: (after ?? before).name,
      before,
      after,
      go: before?.go && after?.go ? diffGo(before.go, after.go) : null,
    }))
    .sort((a, b) => a.relative.localeCompare(b.relative));

// Executables pair by name. A new executable is compared with the old
// release's first one, so an unhardened executable added next to a hardened
// one is still graded.
export const pairRuntimes = (left, right) =>
  pairBy(
    left.runtimes,
    right.runtimes,
    (runtime) => runtime.name,
    () => null,
  ).map(([before, after]) => {
    const baseline = before ?? (after ? (left.runtimes[0] ?? null) : null);
    return {
      name: (after ?? before).name,
      before: baseline,
      after,
      matched: before !== null && after !== null,
      changes:
        baseline?.fuses && after?.fuses
          ? diffFuses(baseline.fuses, after.fuses)
          : [],
    };
  });

const MAX_LINE = 180;
const LEAD = 60;
const STRING = /(["'`])((?:[^"'`\\]|\\.)*)\1/g;

// One source line for display: scrubbed as a whole first, so no window can
// keep part of a secret, then cut to a window around the cited column. On a
// line where REA reported a key-shaped string, every string is masked.
const displayLine = (text, column, sensitive) => {
  const source = sensitive
    ? text.replace(
        STRING,
        (_match, quote, body) => `${quote}${maskTag(body)}${quote}`,
      )
    : text;
  const scrubbed = printable(scrubSource(source));
  if (scrubbed.length <= MAX_LINE) return scrubbed.trim();
  const position = scrubSource(source.slice(0, column ?? 0)).length;
  const start = Math.max(
    0,
    Math.min(position - LEAD, scrubbed.length - MAX_LINE),
  );
  return `${start > 0 ? "…" : ""}${scrubbed.slice(start, start + MAX_LINE).trim()}…`;
};

// Lines where REA reported a string or resolved URL holding a key.
const sensitiveLines = (app) =>
  new Set(
    [...app.stringLiterals, ...app.endpoints]
      .filter(
        (fact) =>
          credentialOf(fact.data.value) ||
          credentialsIn(fact.data.value).length > 0,
      )
      .map((fact) => `${fact.location?.file}:${fact.location?.line}`),
  );

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
      const where = `${item.location.file}:${item.location.line}`;
      if (shown.has(where)) continue;
      if (item.artifact_sha256 !== null && !digests.has(item.artifact_sha256))
        continue;
      const snippet = sources.lineAt(item.location.file, item.location.line);
      if (snippet === null) continue;
      item.snippet = {
        line: snippet.line,
        text: displayLine(
          snippet.text,
          item.location.column,
          sensitive.has(where),
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

// Several applications as one: every fact family concatenated, coverage the
// weakest of them. Used as the old side of a component the old release did
// not have, so code that moved between components is not new.
const mergeApplications = (apps) => {
  if (apps.length === 0) return null;
  const merged = {};
  for (const [key, value] of Object.entries(apps[0])) {
    if (Array.isArray(value)) merged[key] = apps.flatMap((app) => app[key]);
    else if (value instanceof Map)
      merged[key] = new Map(apps.flatMap((app) => [...app[key]]));
    else if (value instanceof Set)
      merged[key] = new Set(apps.flatMap((app) => [...app[key]]));
    else merged[key] = value;
  }
  // A version belongs to one component, not to the release as a whole.
  merged.package = null;
  const weakest = (field) =>
    apps.every((app) => app.coverage[field] === "complete")
      ? "complete"
      : "partial";
  merged.coverage = {
    ...apps[0].coverage,
    graph: weakest("graph"),
    semantic: weakest("semantic"),
    semantic_ceiling_modules: apps.flatMap(
      (app) => app.coverage.semantic_ceiling_modules,
    ),
  };
  return merged;
};

// A side failed when its target was analyzable but REA produced no facts.
const failed = (side) =>
  side.target !== null && side.target.app !== null && side.app === null;

// Compare and grade one collected component against the release baseline.
const finishComponent = async ({
  collected,
  oldRelease,
  releaseLabels: labelsOfRelease,
  baseline,
  rea,
  outDir,
  options,
}) => {
  const { name } = collected;
  // A component the old release lacks is compared with the whole old
  // release; a missing side is named by its release.
  const leftSide =
    collected.left.target === null
      ? { ...emptyCollection(), app: mergeApplications(oldRelease) }
      : collected.left;
  const labels = distinct(
    versionLabel(leftSide, labelsOfRelease.left),
    versionLabel(collected.right, labelsOfRelease.right),
  );
  const left = { ...leftSide, label: labels.left };
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
    runtimes: pairRuntimes(left, right),
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
    releaseLabels: labelsOfRelease,
    // Without an analyzed old side every fact would look new, so only
    // coverage is graded and the analysis error decides the verdict.
    coverageOnly: failed(collected.left),
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

/**
 * Components pair by manifest name. A component left unpaired on each side
 * with the same kind of target is taken as renamed when it is the only such
 * pair, so its captures are still compared.
 */
const pairComponents = (leftRelease, rightRelease) =>
  pairBy(
    leftRelease.components,
    rightRelease.components,
    (component) => component.name,
    (component) => component.target.kind,
  )
    // In the new release's manifest order, removed components last.
    .sort(
      ([, a], [, b]) =>
        (a === null ? Infinity : rightRelease.components.indexOf(a)) -
        (b === null ? Infinity : rightRelease.components.indexOf(b)),
    )
    .map(([before, after]) => ({
      name:
        before && after && before.name !== after.name
          ? `${before.name}-to-${after.name}`
          : (after ?? before).name,
      renamed:
        before && after && before.name !== after.name
          ? { from: before.name, to: after.name }
          : null,
      leftTarget: before?.target ?? null,
      rightTarget: after?.target ?? null,
    }));

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
  const oldSides = collected.map((component) => component.left);
  const oldRelease = oldSides.map((side) => side.app).filter(Boolean);
  const baseline = releaseBaseline(oldSides);
  const components = [];
  for (const component of collected) {
    const finished = await finishComponent({
      collected: component,
      oldRelease,
      releaseLabels: labels,
      baseline,
      rea,
      outDir,
      options,
    });
    components.push({ ...finished, renamed: component.renamed });
  }
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
