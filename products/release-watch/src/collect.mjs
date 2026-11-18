// Runs the REA operations that apply to one side of one component and
// projects their Evidence into facts. REA's output bytes are saved under
// evidence/ exactly as REA wrote them.
import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { applicationFacts } from "./facts/application.mjs";
import { fuseFacts, goFacts, nativeFacts } from "./facts/binaries.mjs";
import { captureFacts } from "./facts/capture.mjs";
import { reaAnalysisArguments } from "./limits.mjs";

const API_SURFACE_PAGE = 1000;

const evidencePath = (scope, name) =>
  path.join(scope.outDir, "evidence", `${scope.prefix}-${name}.json`);
const relative = (scope, file) => path.relative(scope.outDir, file);

const analyzeApp = async (scope) => {
  const { rea, target, errors } = scope;
  if (target.app === null) return null;
  const file = evidencePath(scope, "application");
  const result = await rea.run(
    "analyze-javascript-application",
    [target.app, ...reaAnalysisArguments(scope.analysis)],
    {
      label: `analyze ${scope.label}`,
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
  return { facts: applicationFacts(result.evidence), file };
};

/**
 * Fuse wires of every root executable, and how the inspection ended:
 * `{ runtimes, status: { candidates, failures } }`. An executable with no
 * wire is not a runtime; its Evidence file is removed.
 */
const inspectFuses = async (scope) => {
  const runtimes = [];
  const failures = [];
  for (const [index, candidate] of scope.target.runtimeCandidates.entries()) {
    const name = path.basename(candidate);
    const file = evidencePath(scope, `fuses-${index + 1}-${fileSafe(name)}`);
    const result = await scope.rea.run("inspect-electron-fuses", [candidate], {
      label: `fuses ${scope.label} ${name}`,
      saveTo: file,
    });
    if (!result.ok) {
      failures.push({
        name,
        code: result.error.code,
        message: result.error.message,
      });
      continue;
    }
    const fuses = fuseFacts(result.evidence);
    if (fuses === null) {
      rmSync(file, { force: true });
      continue;
    }
    runtimes.push({
      name,
      path: candidate,
      fuses,
      file: relative(scope, file),
    });
  }
  return {
    runtimes,
    status: { candidates: scope.target.runtimeCandidates.length, failures },
  };
};

// A file name for Evidence: letters, digits, dot, dash and underscore, at
// most 48 characters, so an odd helper name cannot break or escape --out.
const fileSafe = (name) => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);

// How REA identified a helper: "go" with build information, "not-go" when
// REA read the file but found none, "failed" when the operation failed.
const identification = (result, go) =>
  !result.ok ? "failed" : go === null ? "not-go" : "go";

const inspectHelpers = async (scope) => {
  const helpers = [];
  for (const [index, helper] of scope.target.helpers.entries()) {
    const name = path.basename(helper);
    // Helpers in different directories can share a name; the index keeps
    // their Evidence files apart.
    const file = evidencePath(scope, `helper-${index + 1}-${fileSafe(name)}`);
    const result = await scope.rea.run("inspect-go-binary", [helper], {
      label: `go ${scope.label} ${name}`,
      saveTo: file,
    });
    const go = result.ok ? goFacts(result.evidence) : null;
    helpers.push({
      relative: path.relative(scope.target.root, helper),
      name,
      go,
      file: result.ok ? relative(scope, file) : null,
      identified: identification(result, go),
      error: result.ok ? null : result.error,
    });
  }
  return helpers;
};

/** How many native files of one side REA inspects; the rest are named as not inspected. */
export const MAX_NATIVE_FILES = 64;

const DIGEST_CHUNK = 1 << 20;

// A file's size and SHA-256, read in pieces, for a native file REA could
// not inspect: whether its content changed is still known. Null when the
// file cannot be read.
const digestOf = (file) => {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(DIGEST_CHUNK);
  let bytes = 0;
  try {
    const descriptor = openSync(file, "r");
    try {
      for (;;) {
        const read = readSync(descriptor, chunk, 0, DIGEST_CHUNK, null);
        if (read === 0) break;
        hash.update(chunk.subarray(0, read));
        bytes += read;
      }
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return null;
  }
  return { sha256: hash.digest("hex"), bytes };
};

/**
 * What each native candidate of the side is: `{ natives, status }`.
 * `natives` are `{ relative, sha256, bytes, format, architecture, rustc,
 * file, error }`. When REA could not inspect a file, `error` says why,
 * format and architecture are null and the digest is Release Watch's own
 * (null when the file cannot be read). `status` counts the candidates and
 * names those left uninspected.
 */
const inspectNatives = async (scope) => {
  const { files, more } = scope.target.natives;
  const natives = [];
  for (const [index, native] of files.slice(0, MAX_NATIVE_FILES).entries()) {
    const relativePath = path.relative(scope.target.root, native);
    const file = evidencePath(
      scope,
      `native-${index + 1}-${fileSafe(path.basename(native))}`,
    );
    const result = await scope.rea.run("inspect-rust-binary", [native], {
      label: `native ${scope.label} ${relativePath}`,
      saveTo: file,
    });
    natives.push(
      result.ok
        ? {
            relative: relativePath,
            ...nativeFacts(result.evidence),
            file: relative(scope, file),
            error: null,
          }
        : {
            relative: relativePath,
            sha256: null,
            bytes: null,
            ...digestOf(native),
            format: null,
            architecture: null,
            rustc: [],
            file: null,
            error: result.error,
          },
    );
  }
  return {
    natives,
    status: {
      candidates: files.length + more,
      uninspected: files
        .slice(MAX_NATIVE_FILES)
        .map((native) => path.relative(scope.target.root, native)),
      unnamed: more,
    },
  };
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
  return result.ok
    ? { evidence: result.evidence, error: null }
    : { evidence: null, error: result.error };
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
    surface.evidence,
    path.basename(target.capture),
  );
  if (surface.error)
    facts.gaps.push(
      `REA's api-surface view failed (${surface.error.message}); API endpoints were not compared.`,
    );
  if (surface.evidence?.normalized_result?.coverage?.exhausted === false)
    facts.gaps.push(
      `Release Watch read the first ${API_SURFACE_PAGE} API groups of this capture; later groups are not compared.`,
    );
  return { ...facts, file: relative(scope, file) };
};

/**
 * Collect one side of one component. `component` is the side's manifest
 * name, `side` is "left" or "right"; `label` names it in progress lines;
 * `analysis` holds the limits.mjs settings for REA's JavaScript analysis.
 * Evidence files start with `${component}-${side}`, unique because a
 * manifest's names differ even without case. Errors are appended to
 * `errors`.
 */
export const collectSide = async ({
  rea,
  component,
  side,
  label,
  target,
  outDir,
  errors,
  analysis,
}) => {
  const scope = {
    rea,
    component,
    side,
    label,
    target,
    outDir,
    errors,
    analysis,
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
    return emptyCollection(target);
  }
  // A directory of native files has no application to analyze, which is
  // no error: its files are what the release is compared by.
  if (target.kind === "native") {
    const native = await inspectNatives(scope);
    return {
      ...emptyCollection(target),
      natives: native.natives,
      nativeStatus: native.status,
    };
  }
  const electron = target.kind === "electron-dist";
  const [app, fuses, helpers, capture, native] = await Promise.all([
    analyzeApp(scope),
    electron ? inspectFuses(scope) : null,
    electron ? inspectHelpers(scope) : [],
    inspectCapture(scope),
    inspectNatives(scope),
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
    runtimes: fuses?.runtimes ?? [],
    runtimeStatus: fuses?.status ?? { candidates: 0, failures: [] },
    helpers,
    natives: native.natives,
    nativeStatus: native.status,
    capture,
  };
};

/** A side with nothing collected. */
export const emptyCollection = (target = null) => ({
  target,
  app: null,
  appFile: null,
  appEvidence: null,
  runtimes: [],
  runtimeStatus: { candidates: 0, failures: [] },
  helpers: [],
  natives: [],
  nativeStatus: { candidates: 0, uninspected: [], unnamed: 0 },
  capture: null,
});
