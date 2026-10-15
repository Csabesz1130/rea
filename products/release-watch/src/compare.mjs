// Orchestrates one release comparison: REA analysis of every component on
// both sides, the capability diff, policy evaluation and the report model.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { collectSide } from "./collect.mjs";
import {
  diffApplications,
  diffCaptures,
  diffFuses,
  diffGo,
  moduleAliases,
} from "./diff.mjs";
import { discoverRelease } from "./discover.mjs";
import { evaluateComponent, numberFindings, verdictFor } from "./policy.mjs";
import { openSources } from "./sources.mjs";
import { surfaceNames, surfacesOf } from "./surfaces.mjs";

const versionLabel = (side, fallback) =>
  side.app?.package?.version ? `v${side.app.package.version}` : fallback;

// A release is named by its manifest version, else the first component
// package version, else its directory name.
const releaseLabel = (release, components, side) => {
  if (release.version) return `v${release.version}`;
  const version = components
    .map((component) => component[side].app?.package?.version)
    .find(Boolean);
  return version ? `v${version}` : path.basename(release.root);
};

// REA compares two application graphs; its input is assembled from the two
// saved Evidence files without re-serializing them.
const reaComparison = async ({ rea, component, left, right, outDir }) => {
  if (left.appFile === null || right.appFile === null) return null;
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
      go:
        before?.go || after?.go
          ? diffGo(before?.go ?? null, after?.go ?? null)
          : null,
    };
  });
};

const MAX_LINE = 180;

// Redact first, then shorten, so a truncated line can never keep part of a
// redacted value.
const displayLine = (text, pairs) => {
  const redacted = pairs.reduce(
    (result, pair) => result.split(pair.value).join(pair.with ?? "[redacted]"),
    text,
  );
  return redacted.length > MAX_LINE
    ? `${redacted.slice(0, MAX_LINE)}…`
    : redacted;
};

/** Drop the redaction lists, which hold the raw values, once snippets are attached. */
const dropRedactions = (findings) => {
  for (const finding of findings)
    for (const item of finding.evidence) delete item.redact;
};

// Source lines for display: verified against REA's digest, with any value a
// rule marked sensitive replaced before the line enters the report.
const attachSources = (findings, side, sources) => {
  if (sources === null) return;
  const digests = new Set(side.app.assets.map((asset) => asset.data.sha256));
  for (const finding of findings) {
    const shown = new Set(
      finding.evidence
        .filter((item) => item.snippet?.release === side.label)
        .map((item) => `${item.location.file}:${item.location.line}`),
    );
    for (const item of finding.evidence) {
      if (item.snippet || !item.location?.line) continue;
      const where = `${item.location.file}:${item.location.line}`;
      if (shown.has(where)) continue;
      if (item.artifact_sha256 !== null && !digests.has(item.artifact_sha256))
        continue;
      const snippet = sources.lineAt(item.location.file, item.location.line);
      if (snippet === null) continue;
      item.snippet = {
        ...snippet,
        text: displayLine(snippet.text, item.redact ?? []),
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

const emptySide = (label) => ({
  label,
  target: null,
  app: null,
  appFile: null,
  appEvidence: null,
  runtime: null,
  helpers: [],
  capture: null,
  surfaces: { electron: [], web: [], ai: [], mcp: [] },
});

const compareComponent = async ({
  name,
  leftTarget,
  rightTarget,
  rea,
  outDir,
  options,
  errors,
  fallbackLabels,
}) => {
  const collect = (side, target) =>
    target === null
      ? Promise.resolve(emptySide(side))
      : collectSide({
          rea,
          component: name,
          side,
          label: `${name} ${side === "left" ? "old" : "new"}`,
          target,
          outDir,
          errors,
        });
  const [leftRaw, rightRaw] = await Promise.all([
    collect("left", leftTarget),
    collect("right", rightTarget),
  ]);
  const left = {
    ...leftRaw,
    label: versionLabel(leftRaw, fallbackLabels.left),
  };
  const right = {
    ...rightRaw,
    label: versionLabel(rightRaw, fallbackLabels.right),
  };
  left.surfaces = surfacesOf(left);
  right.surfaces = surfacesOf(right);
  const [comparison, rightSources, leftSources] = await Promise.all([
    reaComparison({ rea, component: name, left, right, outDir }),
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
    diff,
    surfaces,
    options,
    labels: { left: left.label, right: right.label },
  });
  try {
    attachSources(findings, right, rightSources);
    attachSources(findings, left, leftSources);
  } finally {
    rightSources?.close();
    leftSources?.close();
    dropRedactions(findings);
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
  const components = [];
  // Components run one after another; each runs its two sides in parallel.
  const fallbackLabels = {
    left: leftRelease.version ? `v${leftRelease.version}` : "old",
    right: rightRelease.version ? `v${rightRelease.version}` : "new",
  };
  for (const pair of pairComponents(leftRelease, rightRelease))
    components.push(
      await compareComponent({
        ...pair,
        rea,
        outDir,
        options,
        errors,
        fallbackLabels,
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
    labels: {
      left: releaseLabel(leftRelease, components, "left"),
      right: releaseLabel(rightRelease, components, "right"),
    },
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
