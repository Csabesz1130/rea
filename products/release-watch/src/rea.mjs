// Runs REA CLI operations and returns their Evidence JSON with timing.
import { constants } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundledCli = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/rea.mjs",
);

/** Resolve the REA command: an explicit path, this checkout's CLI, or `rea` on PATH. */
export const resolveReaCommand = (explicit) => {
  const selected = explicit ?? process.env.REA_CLI ?? null;
  if (selected !== null) {
    return selected.endsWith(".mjs") || selected.endsWith(".js")
      ? { command: process.execPath, prefix: [selected] }
      : { command: selected, prefix: [] };
  }
  if (existsSync(bundledCli))
    return { command: process.execPath, prefix: [bundledCli] };
  return { command: "rea", prefix: [] };
};

const runProcess = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) =>
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: String(error) }),
    );
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });

const lastStderrLine = (stderr) =>
  stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";

// REA's validation errors list the failing fields under details.issues.
const issuesOf = (parsed) =>
  (Array.isArray(parsed?.details?.issues) ? parsed.details.issues : [])
    .slice(0, 3)
    .map((issue) => {
      const where =
        Array.isArray(issue.path) && issue.path.length > 0
          ? issue.path.join(".")
          : "input";
      return `${where}: ${issue.message ?? issue.reason ?? "invalid"}${issue.expected ? ` (expected ${issue.expected})` : ""}`;
    });

const parse = (bytes) => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
};

// Output REA completed that exceeds `maxOutputBytes`, the largest JSON text
// Release Watch parses (V8 caps one string at about 512 MiB).
const tooLarge = (outcome, maxOutputBytes) =>
  outcome.code === 0 && outcome.stdout.length > maxOutputBytes;

// Why a call failed, from REA's error output, else its stderr or exit code.
// Complete output too large to parse says so, and where it was saved.
const failureOf = (operation, outcome, parsed, { maxOutputBytes, saveTo }) => {
  if (tooLarge(outcome, maxOutputBytes))
    return {
      operation,
      code: "output_too_large",
      message: `REA's output is ${Math.round(outcome.stdout.length / 2 ** 20)} MiB, more than Release Watch can read as one JSON text (${Math.floor(maxOutputBytes / 2 ** 20)} MiB)${saveTo === null ? "" : `; it is saved in full as ${saveTo}`}; lower --max-semantic-nodes`,
    };
  return {
    operation,
    code: parsed?.code ?? null,
    message: [
      parsed?.message ??
        (lastStderrLine(outcome.stderr) || `exit code ${outcome.code}`),
      ...issuesOf(parsed),
    ].join("; "),
  };
};

/**
 * Create a runner that records every REA call it makes. Each call resolves to
 * `{ ok: true, evidence, file }` or `{ ok: false, error }`; it never throws for
 * an REA failure, so callers can keep partial results. With `saveTo`, REA's
 * exact output bytes are written to that file, also when REA completed but
 * its output is larger than `maxOutputBytes`, the largest output Release
 * Watch parses (V8's string limit).
 */
export const createRea = (
  resolved,
  { onCall = () => {}, maxOutputBytes = constants.MAX_STRING_LENGTH } = {},
) => {
  const calls = [];
  const run = async (
    operation,
    operands,
    { label = operation, saveTo = null } = {},
  ) => {
    const started = performance.now();
    const outcome = await runProcess(resolved.command, [
      ...resolved.prefix,
      operation,
      ...operands,
      "--format",
      "json",
    ]);
    const elapsedMs = Math.round(performance.now() - started);
    const parsed =
      outcome.stdout.length > maxOutputBytes ? null : parse(outcome.stdout);
    const failed =
      outcome.code !== 0 || parsed === null || typeof parsed.error === "string";
    // Complete Evidence is kept even when Release Watch cannot read it.
    if ((!failed || tooLarge(outcome, maxOutputBytes)) && saveTo !== null)
      writeFileSync(saveTo, outcome.stdout);
    const record = {
      label,
      operation,
      elapsed_ms: elapsedMs,
      ok: !failed,
      evidence_id: failed ? null : (parsed.evidence_id ?? null),
      output_bytes: outcome.stdout.length,
    };
    calls.push(record);
    onCall(record);
    if (!failed) return { ok: true, evidence: parsed, file: saveTo };
    return {
      ok: false,
      error: failureOf(operation, outcome, parsed, { maxOutputBytes, saveTo }),
    };
  };
  return { run, calls };
};
