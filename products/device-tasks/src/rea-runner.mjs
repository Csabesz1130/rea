import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const TASK_OUTPUT_LIMIT = 16 * 1024 * 1024;

/** Reuse REA process ownership; do not implement PID/group signaling here. */
export async function createRunner(
  options,
  report,
  checkpoint,
  signal,
  { runCommand } = {},
) {
  const [
    { runOwnedCommand },
    { parseEvidence },
    { adbResultSchemas },
    { AnalysisError },
    { projectAnalysisError },
  ] = await Promise.all([
    import("../../../dist/process/OwnedCommand.js"),
    import("../../../dist/domain/evidence.js"),
    import("../../../dist/domain/adb/adbDeviceAnalysis.js"),
    import("../../../dist/domain/analysisErrorBase.js"),
    import("../../../dist/domain/analysisErrorProjection.js"),
  ]);
  const retainedCleanup = [];
  let outputBytes = 0;
  const isScript = /\.[cm]?js$/u.test(options.rea);
  const executable = isScript ? process.execPath : options.rea;
  const prefix = isScript ? [options.rea] : [];

  const run = async (args, label = args[0]) => {
    signal.throwIfAborted();
    const number = report.calls.length + 1;
    const file = `evidence/${String(number).padStart(2, "0")}-${args[0]}.json`;
    const argv = [...prefix, ...args, "--format", "json", "--full-output"];
    const runId = `device-tasks-${randomUUID()}`;
    const record = {
      sequence: number,
      label,
      command: executable,
      arguments: argv,
      run_id: runId,
      operation: args[0].replaceAll("-", "_"),
      status: "running",
      started_at: new Date().toISOString(),
      elapsed_ms: null,
      exit_code: null,
      signal: null,
      output_complete: false,
      stdout_bytes: 0,
      stderr_bytes: 0,
      evidence_id: null,
      file,
      error: null,
    };
    report.calls.push(record);
    await checkpoint();
    const started = performance.now();
    let snapshot = null;
    let failure = null;
    try {
      const remaining = TASK_OUTPUT_LIMIT - outputBytes;
      if (remaining <= 0)
        throw Object.assign(
          new Error("Task REA output budget exhausted before process launch."),
          { reason: "output-limit" },
        );
      snapshot = await (runCommand ?? runOwnedCommand)(
        {
          command: executable,
          arguments: argv,
          runId,
          expectedCommand: isScript ? null : executable,
        },
        {
          timeoutMs: options.callTimeoutMs,
          diagnosticBytes: Math.min(OUTPUT_LIMIT, remaining),
          acceptNonZeroExit: true,
        },
        {
          signal,
          retainCleanup: (owner, result) => {
            const item = { owner, result, call: number };
            retainedCleanup.push(item);
            report.cleanup.push({
              call: number,
              status: "incomplete",
              reason: result.reason,
            });
          },
        },
      );
    } catch (error) {
      snapshot = error.snapshot ?? null;
      failure = {
        ...(error instanceof AnalysisError
          ? projectAnalysisError(error)
          : {
              code: [
                "cancelled",
                "timeout",
                "output-limit",
                "process",
              ].includes(error.reason)
                ? error.reason
                : "process_error",
              message: error.message,
            }),
        cleanup_failure: error.cleanupFailure ?? null,
        resources: error.resources ?? [],
      };
      // If the shared supervisor returned unresolved ownership, retain it.
      if (error.cleanupOwner)
        retainedCleanup.push({ owner: error.cleanupOwner, call: number });
    }
    record.elapsed_ms = Math.round(performance.now() - started);
    record.exit_code = snapshot?.exitCode ?? null;
    record.signal = snapshot?.signal ?? null;
    record.stdout_bytes = snapshot?.stdout.observedBytes ?? 0;
    record.stderr_bytes = snapshot?.stderr.observedBytes ?? 0;
    outputBytes +=
      (snapshot?.stdout.bytes ?? 0) + (snapshot?.stderr.bytes ?? 0);
    record.output_complete =
      snapshot !== null &&
      !snapshot.diagnosticTruncated &&
      !snapshot.outputIncomplete &&
      !snapshot.stdout.invalidUtf8;
    record.stderr = snapshot?.stderr.text ?? "";
    let envelope = null;
    if (record.output_complete) {
      try {
        envelope = JSON.parse(snapshot.stdout.text);
      } catch {
        record.output_complete = false;
        failure ??= {
          code: "invalid_json",
          message: "REA did not return a JSON document.",
        };
      }
    }
    // Preserve exact returned documents, or explicitly labelled partial output.
    if (!record.output_complete)
      record.file = file.replace(".json", ".partial.txt");
    await writeFile(
      path.join(options.output, record.file),
      snapshot?.stdout.text ?? "",
      { flag: "wx" },
    );
    let evidence = null;
    if (envelope?.ok === true) {
      try {
        evidence = parseEvidence(envelope.data);
        // Even an authenticated record with the wrong identity remains retained.
        const retained = {
          call: number,
          file,
          request_binding: "unresolved",
          record: evidence,
        };
        report.evidence.push(retained);
        if (
          evidence.operation !== record.operation ||
          evidence.provider.id !== "adb"
        )
          throw new Error("Unexpected operation or provider identity.");
        const schema = adbResultSchemas[record.operation];
        if (!schema)
          throw new Error("Operation is outside the fixed ADB workflow.");
        schema.parse(evidence.normalized_result);
        if (
          record.operation === "list_adb_packages" &&
          (evidence.parameters.scope !== "all" ||
            evidence.normalized_result.scope !== "all")
        )
          throw new Error(
            "Evidence package scope differs from the fixed all-packages request.",
          );
        if (record.operation === "capture_adb_screen") {
          const outputDirectory = args[args.indexOf("--output-directory") + 1];
          if (
            evidence.parameters.output_directory !== outputDirectory ||
            path.dirname(evidence.normalized_result.local_path) !==
              outputDirectory
          )
            throw new Error(
              "Capture Evidence output differs from the selected directory.",
            );
        }
        if (
          args[1] !== undefined &&
          evidence.normalized_result.serial !== options.serial
        )
          throw new Error(
            "Returned Evidence serial differs from selected device.",
          );
        if (
          evidence.parameters.serial !== undefined &&
          evidence.parameters.serial !== options.serial
        )
          throw new Error("Evidence parameters identify another device.");
        if (
          args[1] !== undefined &&
          evidence.parameters.serial !== options.serial
        )
          throw new Error("Evidence parameters omit the selected serial.");
        if (
          ["inspect_adb_package", "start_adb_app"].includes(record.operation)
        ) {
          if (
            evidence.parameters.package !== options.package ||
            evidence.normalized_result.package_name !== options.package
          )
            throw new Error(
              "Evidence package differs from the selected package.",
            );
        }
        if (record.operation === "start_adb_activity") {
          if (
            !Array.isArray(evidence.parameters.extras) ||
            evidence.parameters.extras.length !== 0 ||
            evidence.normalized_result.extras.length !== 0
          )
            throw new Error(
              "Intent Evidence includes extras outside the fixed task request.",
            );
          for (const [field, expected] of [
            ["action", args[2]],
            ["component", options.component],
            ["data_uri", options.url],
          ]) {
            if (
              evidence.normalized_result[field] !== expected ||
              (evidence.parameters[field] ?? null) !== expected
            )
              throw new Error(
                `Evidence ${field} differs from the selected intent.`,
              );
          }
        }
        if (record.operation.startsWith("start_adb_")) {
          const component = evidence.normalized_result.component;
          if (
            typeof component !== "string" ||
            component.split("/")[0] !== options.package
          )
            throw new Error("Launch component identifies another package.");
          if (evidence.normalized_result.started_activity === null)
            throw new Error("REA did not establish a launch attempt.");
          const status = evidence.normalized_result.reported_status;
          if (
            status !== null &&
            status !== undefined &&
            status.toLowerCase() !== "ok"
          )
            throw new Error(
              "REA Evidence contains a non-ok Activity Manager status.",
            );
        }
        retained.request_binding = "matched";
        record.evidence_id = evidence.evidence_id;
        if (snapshot?.exitCode !== 0)
          failure ??= {
            code: "process_exit",
            message: `REA returned Evidence but exited ${snapshot?.exitCode}.`,
          };
      } catch (error) {
        failure = { code: "evidence_contract", message: error.message };
        evidence = null;
      }
    } else
      failure ??= !record.output_complete
        ? {
            code: "incomplete_output",
            message:
              "REA output could not be retained as a complete JSON document.",
          }
        : (envelope?.error ?? {
            code: "rea_failed",
            message: `REA exited ${snapshot?.exitCode ?? "without a status"}.`,
          });
    record.error = failure;
    record.status = failure ? "failed" : "completed";
    await checkpoint();
    if (signal.aborted) signal.throwIfAborted();
    return {
      ok: failure === null,
      evidence,
      result: evidence?.normalized_result ?? null,
      call: number,
      error: failure,
    };
  };

  const cleanup = async () => {
    for (const item of retainedCleanup) {
      try {
        const result = await item.owner.stop();
        item.unresolved = result.status === "incomplete";
        report.cleanup.push({ call: item.call, ...result });
      } catch (error) {
        item.unresolved = true;
        report.cleanup.push({
          call: item.call,
          status: "incomplete",
          reason: error.message,
        });
      }
    }
    return retainedCleanup.filter((item) => item.unresolved).length;
  };
  return { run, cleanup };
}
