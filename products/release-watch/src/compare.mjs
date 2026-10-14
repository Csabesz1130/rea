// Orchestrates one release comparison: REA analysis of both releases, the
// capability diff, policy evaluation, and the report model.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { diffApplications, diffFuses, diffGo } from "./diff.mjs";
import { discoverRelease } from "./discover.mjs";
import { applicationFacts, fuseFacts, goFacts } from "./facts.mjs";
import { evaluatePolicy, verdictFor } from "./policy.mjs";
import { openSources } from "./sources.mjs";

const saveEvidence = (outDir, name, evidence) => {
  const file = path.join(outDir, "evidence", `${name}.json`);
  writeFileSync(file, JSON.stringify(evidence));
  return path.relative(outDir, file);
};

const analyzeApp = async ({ rea, side, release, outDir, errors }) => {
  if (release.app === null) return { facts: null, evidence: null, file: null };
  const result = await rea.run(
    "analyze-javascript-application",
    [release.app],
    `analyze ${side}`,
  );
  if (!result.ok) {
    errors.push({ side, ...result.error });
    return { facts: null, evidence: null, file: null };
  }
  return {
    facts: applicationFacts(result.evidence),
    evidence: result.evidence,
    file: saveEvidence(outDir, `${side}-application`, result.evidence),
  };
};

const inspectRuntime = async (rea, side, release, outDir) => {
  for (const candidate of release.runtimeCandidates) {
    const name = path.basename(candidate);
    const result = await rea.run(
      "inspect-electron-fuses",
      [candidate],
      `fuses ${side} ${name}`,
    );
    if (!result.ok) continue;
    const fuses = fuseFacts(result.evidence);
    if (fuses === null) continue;
    return {
      name,
      path: candidate,
      fuses,
      file: saveEvidence(outDir, `${side}-fuses`, result.evidence),
    };
  }
  return null;
};

const inspectHelpers = async (rea, side, release, outDir) => {
  const helpers = [];
  for (const helper of release.helpers) {
    const relative = path.relative(release.root, helper);
    const name = path.basename(helper);
    const result = await rea.run(
      "inspect-go-binary",
      [helper],
      `go ${side} ${name}`,
    );
    helpers.push({
      relative,
      name,
      go: result.ok ? goFacts(result.evidence) : null,
      file: result.ok
        ? saveEvidence(outDir, `${side}-helper-${name}`, result.evidence)
        : null,
      identified: result.ok ? "go" : "unidentified",
    });
  }
  return helpers;
};

const inspectSide = async ({ rea, side, input, outDir, errors }) => {
  const release = discoverRelease(input);
  const [app, runtime, helpers] = await Promise.all([
    analyzeApp({ rea, side, release, outDir, errors }),
    inspectRuntime(rea, side, release, outDir),
    inspectHelpers(rea, side, release, outDir),
  ]);
  const version = app.facts?.package?.version ?? null;
  return {
    input: release.root,
    label: version ? `v${version}` : path.basename(release.root),
    package: app.facts?.package ?? null,
    app: app.facts,
    appPath: release.app,
    appEvidence: app.evidence,
    appEvidenceFile: app.file,
    runtime,
    helpers,
  };
};

const reaComparison = async (rea, left, right, outDir) => {
  if (left.appEvidence === null || right.appEvidence === null) return null;
  const input = path.join(outDir, "evidence", ".compare-input.json");
  writeFileSync(
    input,
    JSON.stringify({ left: left.appEvidence, right: right.appEvidence }),
  );
  const result = await rea.run(
    "compare-application-versions",
    [input],
    "compare versions",
  );
  rmSync(input, { force: true });
  if (!result.ok) return { error: result.error };
  const comparison = result.evidence.normalized_result;
  return {
    evidence_id: result.evidence.evidence_id,
    summary: comparison.summary,
    limitations: comparison.limitations ?? [],
    file: saveEvidence(outDir, "application-comparison", result.evidence),
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

const openSide = (rea, side) => {
  if (!side.app || side.appPath === null) return Promise.resolve(null);
  const assets = new Map(
    side.app.assets.map((asset) => [asset.key, asset.data.sha256]),
  );
  return openSources(rea, side.appPath, assets, side.label);
};

const attachSources = (findings, side, sources) => {
  if (sources === null) return;
  const digests = new Set(side.app.assets.map((asset) => asset.data.sha256));
  for (const finding of findings) {
    const shown = new Set(
      finding.evidence
        .filter((item) => item.snippet)
        .map((item) => `${item.location.file}:${item.location.line}`),
    );
    for (const item of finding.evidence) {
      if (item.snippet || !item.location?.line) continue;
      const where = `${item.location.file}:${item.location.line}`;
      if (shown.has(where)) continue;
      if (item.artifact_sha256 !== null && !digests.has(item.artifact_sha256))
        continue;
      const snippet = sources.lineAt(item.location.file, item.location.line);
      if (snippet) {
        item.snippet = { ...snippet, release: side.label };
        shown.add(where);
      }
    }
  }
};

/** Compare two releases and return the complete report model. */
export const compareReleases = async ({
  left: leftInput,
  right: rightInput,
  outDir,
  rea,
  options,
}) => {
  const started = performance.now();
  mkdirSync(path.join(outDir, "evidence"), { recursive: true });
  const errors = [];
  const [left, right] = await Promise.all([
    inspectSide({ rea, side: "left", input: leftInput, outDir, errors }),
    inspectSide({ rea, side: "right", input: rightInput, outDir, errors }),
  ]);
  const [comparison, rightSources, leftSources] = await Promise.all([
    reaComparison(rea, left, right, outDir),
    openSide(rea, right),
    openSide(rea, left),
  ]);
  const diff = {
    app: diffApplications(left.app, right.app),
    fuses: diffFuses(left.runtime?.fuses ?? null, right.runtime?.fuses ?? null),
    helpers: pairHelpers(left, right),
  };
  const context = {
    left,
    right,
    diff,
    options,
    labels: { left: left.label, right: right.label },
  };
  const findings = evaluatePolicy(context);
  try {
    attachSources(findings, right, rightSources);
    attachSources(findings, left, leftSources);
  } finally {
    rightSources?.close();
    leftSources?.close();
  }
  return {
    tool: { name: "Release Watch", version: "0.1.0" },
    generated_at: new Date().toISOString(),
    product: right.package?.name ?? left.package?.name ?? null,
    left,
    right,
    comparison,
    diff,
    findings,
    verdict: verdictFor(findings, options.failOn),
    errors,
    run: {
      elapsed_ms: Math.round(performance.now() - started),
      rea_calls: rea.calls,
      llm_tokens: 0,
    },
  };
};
