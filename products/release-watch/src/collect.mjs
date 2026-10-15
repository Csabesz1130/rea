// Runs the REA operations that apply to one side of one component and
// projects their Evidence into facts. REA's output bytes are saved under
// evidence/ exactly as REA wrote them.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { applicationFacts } from "./facts/application.mjs";
import { fuseFacts, goFacts } from "./facts/binaries.mjs";
import { captureFacts } from "./facts/capture.mjs";

const API_SURFACE_PAGE = 1000;

const evidencePath = (scope, name) =>
  path.join(scope.outDir, "evidence", `${scope.prefix}-${name}.json`);
const relative = (scope, file) => path.relative(scope.outDir, file);

const analyzeApp = async (scope) => {
  const { rea, target, errors } = scope;
  if (target.app === null) return null;
  const file = evidencePath(scope, "application");
  const result = await rea.run("analyze-javascript-application", [target.app], {
    label: `analyze ${scope.label}`,
    saveTo: file,
  });
  if (!result.ok) {
    errors.push({
      component: scope.component,
      side: scope.side,
      ...result.error,
    });
    return null;
  }
  return { facts: applicationFacts(result.evidence), file };
};

const inspectFuses = async (scope) => {
  for (const candidate of scope.target.runtimeCandidates) {
    const name = path.basename(candidate);
    const file = evidencePath(scope, "fuses");
    const result = await scope.rea.run("inspect-electron-fuses", [candidate], {
      label: `fuses ${scope.label} ${name}`,
      saveTo: file,
    });
    if (!result.ok) continue;
    const fuses = fuseFacts(result.evidence);
    if (fuses === null) {
      rmSync(file, { force: true });
      continue;
    }
    return { name, path: candidate, fuses, file: relative(scope, file) };
  }
  return null;
};

const inspectHelpers = async (scope) => {
  const helpers = [];
  for (const helper of scope.target.helpers) {
    const name = path.basename(helper);
    const file = evidencePath(scope, `helper-${name}`);
    const result = await scope.rea.run("inspect-go-binary", [helper], {
      label: `go ${scope.label} ${name}`,
      saveTo: file,
    });
    helpers.push({
      relative: path.relative(scope.target.root, helper),
      name,
      go: result.ok ? goFacts(result.evidence) : null,
      file: result.ok ? relative(scope, file) : null,
      identified: result.ok ? "go" : "unidentified",
    });
  }
  return helpers;
};

// REA's api-surface view takes the capture Evidence inline; the request is
// assembled from REA's saved bytes rather than re-serialized.
const apiSurface = async (scope, captureFile) => {
  const input = evidencePath(scope, "api-surface-input");
  writeFileSync(
    input,
    Buffer.concat([
      Buffer.from('{"source":{"kind":"inline","evidence":'),
      readFileSync(captureFile),
      Buffer.from(
        `},"view":{"kind":"api-surface","offset":0,"limit":${API_SURFACE_PAGE}}}`,
      ),
    ]),
  );
  const file = evidencePath(scope, "api-surface");
  const result = await scope.rea.run("inspect-analysis-view", [input], {
    label: `api surface ${scope.label}`,
    saveTo: file,
  });
  rmSync(input, { force: true });
  return result.ok ? result.evidence : null;
};

const inspectCapture = async (scope) => {
  const { rea, target, errors } = scope;
  if (target.capture === null) return null;
  const file = evidencePath(scope, "capture");
  const result = await rea.run(
    "inspect-web-network-capture",
    [target.capture, "har"],
    {
      label: `capture ${scope.label}`,
      saveTo: file,
    },
  );
  if (!result.ok) {
    errors.push({
      component: scope.component,
      side: scope.side,
      ...result.error,
    });
    return null;
  }
  const surface = await apiSurface(scope, file);
  const facts = captureFacts(
    result.evidence,
    surface,
    path.basename(target.capture),
  );
  if (surface?.normalized_result?.coverage?.exhausted === false)
    facts.limitations.push(
      `Release Watch read the first ${API_SURFACE_PAGE} API groups of this capture; later groups are not compared.`,
    );
  return { ...facts, file: relative(scope, file) };
};

/**
 * Collect one side of one component. `side` is "left" or "right"; `label`
 * names it in progress lines. Errors are appended to `errors`.
 */
export const collectSide = async ({
  rea,
  component,
  side,
  label,
  target,
  outDir,
  errors,
}) => {
  const scope = {
    rea,
    component,
    side,
    label,
    target,
    outDir,
    errors,
    prefix: `${component}-${side}`,
  };
  if (target.kind === "unknown") {
    errors.push({
      component,
      side,
      operation: "discover",
      code: "no_analyzable_target",
      message: `Nothing to analyze at ${target.root}: ${target.reason}.`,
    });
    return {
      target,
      app: null,
      appFile: null,
      appEvidence: null,
      runtime: null,
      helpers: [],
      capture: null,
    };
  }
  const electron = target.kind === "electron-dist";
  const [app, runtime, helpers, capture] = await Promise.all([
    analyzeApp(scope),
    electron ? inspectFuses(scope) : null,
    electron ? inspectHelpers(scope) : [],
    inspectCapture(scope),
  ]);
  if (
    app === null &&
    capture === null &&
    !errors.some(
      (error) => error.component === component && error.side === side,
    )
  )
    errors.push({
      component,
      side,
      operation: "collect",
      code: "no_facts",
      message: `REA produced no application or capture facts for ${target.root}.`,
    });
  return {
    target,
    app: app?.facts ?? null,
    appFile: app?.file ?? null,
    appEvidence: app ? relative(scope, app.file) : null,
    runtime,
    helpers,
    capture,
  };
};
