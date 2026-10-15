// Runs REA CLI operations and returns their Evidence JSON with timing.
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

const parse = (bytes) => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
};

/**
 * Create a runner that records every REA call it makes. Each call resolves to
 * `{ ok: true, evidence, file }` or `{ ok: false, error }`; it never throws for
 * an REA failure, so callers can keep partial results. With `saveTo`, REA's
 * exact output bytes are written to that file.
 */
export const createRea = (resolved, { onCall = () => {} } = {}) => {
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
    const parsed = parse(outcome.stdout);
    const failed =
      outcome.code !== 0 || parsed === null || typeof parsed.error === "string";
    if (!failed && saveTo !== null) writeFileSync(saveTo, outcome.stdout);
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
      error: {
        operation,
        code: parsed?.code ?? null,
        message:
          parsed?.message ??
          (lastStderrLine(outcome.stderr) || `exit code ${outcome.code}`),
      },
    };
  };
  return { run, calls };
};
