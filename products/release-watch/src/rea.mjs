// Runs REA CLI operations and returns their Evidence JSON with timing.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
      resolve({ code: null, stdout: "", stderr: String(error) }),
    );
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });

const lastStderrLine = (stderr) =>
  stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";

/**
 * Create a runner that records every REA call it makes. Each call resolves to
 * `{ ok: true, evidence }` or `{ ok: false, error }`; it never throws for an
 * REA failure, so callers can keep partial results.
 */
export const createRea = (resolved, { onCall = () => {} } = {}) => {
  const calls = [];
  const run = async (operation, operands, label = operation) => {
    const started = performance.now();
    const outcome = await runProcess(resolved.command, [
      ...resolved.prefix,
      operation,
      ...operands,
      "--format",
      "json",
    ]);
    const elapsedMs = Math.round(performance.now() - started);
    let parsed = null;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      parsed = null;
    }
    const failed =
      outcome.code !== 0 || parsed === null || typeof parsed.error === "string";
    const record = {
      label,
      operation,
      elapsed_ms: elapsedMs,
      ok: !failed,
      evidence_id: failed ? null : (parsed.evidence_id ?? null),
      output_bytes: Buffer.byteLength(outcome.stdout),
    };
    calls.push(record);
    onCall(record);
    if (!failed) return { ok: true, evidence: parsed };
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
