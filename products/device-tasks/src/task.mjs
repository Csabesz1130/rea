import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { launchArguments, planTask } from "./options.mjs";
import { writeReports } from "./reports.mjs";

class TaskRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Interpret the normalized focus field only; never search a package substring. */
function currentFocus(result, expected) {
  const packageOf = (declaration) => {
    if (declaration === null) return null;
    const matches = [
      ...declaration.matchAll(
        /(?:^|\s)([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\/[A-Za-z0-9_.$]+(?=\s|\}|$)/gu,
      ),
    ];
    const packages = [...new Set(matches.map((match) => match[1]))];
    return packages.length === 1 ? packages[0] : null;
  };
  const pkg = packageOf(result.focused_window);
  const appPackage = packageOf(result.focused_app);
  const conflict =
    result.focused_app !== null && (appPackage === null || appPackage !== pkg);
  return {
    package: pkg,
    focused_app_package: appPackage,
    conflict,
    matches: pkg === expected && !conflict,
    declaration: result.focused_window,
  };
}

export async function executeTask(
  options,
  { signal: callerSignal, runnerFactory } = {},
) {
  if (options.dryRun) return planTask(options);
  // Exclusive creation prevents replacing or mixing a previous task's artifacts.
  await mkdir(options.output);
  await mkdir(path.join(options.output, "evidence"));
  if (options.captureScreen) await mkdir(path.join(options.output, "screens"));
  const started = performance.now();
  const report = {
    schema_version: 1,
    exploratory: true,
    status: "running",
    command: options.command,
    started_at: new Date().toISOString(),
    finished_at: null,
    elapsed_ms: null,
    selection: {
      serial: options.serial,
      package: options.package,
      component: options.component,
      url: options.url,
    },
    goal:
      options.command === "open"
        ? "Establish that the exact expected package has current window focus at one post-launch observation."
        : "Collect readiness, identity, installed packages, display and window focus Evidence for the selected serial.",
    bounds: planTask(options).bounds,
    effects: {
      requested_app_launches: options.command === "open" ? 1 : 0,
      launch_attempted: false,
      local_reports: true,
      screen_captures_requested: options.captureScreen,
      adb_server_may_start: true,
    },
    facts: [],
    unknowns: [
      "Current focus is a window-manager declaration at one read time, not device attestation or continued focus.",
      "App usability, playback, successful URL handling, authentication and content availability are not established.",
      "No claim is made about device identity beyond the caller-selected ADB serial and returned properties.",
      "Token usage, process-family CPU and peak memory have not been measured.",
    ],
    calls: [],
    evidence: [],
    focus_observations: [],
    cleanup: [],
    error: null,
  };
  const checkpoint = () => writeReports(options.output, report);
  await checkpoint();
  const timeout = AbortSignal.timeout(options.taskTimeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeout])
    : timeout;
  let runner;
  const addFact = (confidence, text, calls) =>
    report.facts.push({ confidence, text, calls });
  const must = async (args, label) => {
    const result = await runner.run(args, label);
    if (!result.ok)
      throw new TaskRefusal(
        result.error?.code ?? "rea_failed",
        result.error?.message ?? "REA call failed.",
      );
    return result;
  };
  const readiness = async () => {
    const devices = await must(
      ["list-adb-devices"],
      "selected-device readiness",
    );
    const matching = devices.result.devices.filter(
      (device) => device.serial === options.serial,
    );
    if (matching.length !== 1)
      throw new TaskRefusal(
        "device_mismatch",
        `Expected exactly one declaration for selected serial ${options.serial}; observed ${matching.length}.`,
      );
    addFact(
      "observed",
      `Selected device ${options.serial} reported state ${matching[0].state}.`,
      [devices.call],
    );
    if (matching[0].state !== "device")
      throw new TaskRefusal(
        "device_not_ready",
        `Selected serial reports ${matching[0].state}; no app launch was attempted.`,
      );
    return devices;
  };
  const optional = async (args, label) => {
    const result = await runner.run(args, label);
    if (!result.ok) {
      report.unknowns.push(
        `${label} was not established: ${result.error?.message ?? "REA call failed"}.`,
      );
      report.status = "partial";
    }
    return result;
  };
  try {
    signal.throwIfAborted();
    const createRunner =
      runnerFactory ?? (await import("./rea-runner.mjs")).createRunner;
    runner = await createRunner(options, report, checkpoint, signal);
    const client = await must(["inspect-adb-client"]);
    addFact(
      "observed",
      `REA selected ADB client ${client.result.client.binary_path}, version ${client.result.client.version ?? "unknown"}.`,
      [client.call],
    );
    await readiness();
    const identity = await must(["inspect-adb-device", options.serial]);
    addFact(
      "observed",
      `REA returned ${identity.result.property_count} selected build properties for ${options.serial}.`,
      [identity.call],
    );
    const packages = await must(["list-adb-packages", options.serial]);
    addFact(
      "observed",
      `Package inventory returned ${packages.result.packages.length} entries with ${packages.result.coverage} coverage.`,
      [packages.call],
    );
    if (options.package) {
      const installed = packages.result.packages.filter(
        (pkg) => pkg.package_name === options.package,
      );
      if (installed.length !== 1)
        throw new TaskRefusal(
          "package_not_established",
          `Exact installed package ${options.package} was not established by one inventory entry; observed ${installed.length}.`,
        );
      addFact(
        "observed",
        `Exact package ${options.package} is present in the installed-package inventory.`,
        [packages.call],
      );
      await optional(
        ["inspect-adb-package", options.serial, options.package],
        "selected package metadata",
      );
    }
    await optional(
      ["inspect-adb-display", options.serial],
      "display declaration",
    );
    await optional(
      ["inspect-adb-window", options.serial],
      "initial window focus",
    );
    if (options.captureScreen)
      await optional(
        [
          "capture-adb-screen",
          options.serial,
          "--output-directory",
          path.join(options.output, "screens", "before"),
        ],
        "before screen capture",
      );
    if (options.command === "open") {
      // Recheck the exact serial after inspection; never select a replacement.
      await readiness();
      signal.throwIfAborted();
      report.effects.launch_attempted = true;
      await checkpoint();
      const launch = await must(launchArguments(options), "single app launch");
      if (
        launch.result.package_name !== undefined &&
        launch.result.package_name !== options.package
      )
        throw new TaskRefusal(
          "package_mismatch",
          "Launch Evidence identifies a different package.",
        );
      addFact(
        "observed",
        "REA returned a successful Activity Manager launch verdict. This does not establish the task goal.",
        [launch.call],
      );
      let focused = false;
      for (let attempt = 1; attempt <= options.attempts; attempt++) {
        if (attempt > 1) await delay(options.intervalMs, undefined, { signal });
        const observed = await must(
          ["inspect-adb-window", options.serial],
          `post-launch focus observation ${attempt}`,
        );
        const focus = currentFocus(observed.result, options.package);
        report.focus_observations.push({
          attempt,
          call: observed.call,
          observed_at: new Date().toISOString(),
          ...focus,
        });
        if (focus.matches) {
          addFact(
            "derived",
            `The current-focus declaration identified exact package ${options.package} at observation ${attempt}.`,
            [observed.call],
          );
          focused = true;
          break;
        }
        await checkpoint();
      }
      if (!focused) {
        report.unknowns.push(
          `Current focus on exact package ${options.package} was not established within ${options.attempts} observations; launch was not retried.`,
        );
        report.status = "not_verified";
      } else if (report.status !== "partial") report.status = "verified_focus";
      if (options.captureScreen)
        await optional(
          [
            "capture-adb-screen",
            options.serial,
            "--output-directory",
            path.join(options.output, "screens", "after"),
          ],
          "after screen capture",
        );
    } else if (report.status !== "partial") report.status = "inspected";
  } catch (error) {
    report.status = signal.aborted
      ? timeout.aborted && !callerSignal?.aborted
        ? "timeout"
        : "cancelled"
      : "failed";
    report.error = {
      code: error.code ?? error.name ?? "task_error",
      message: error.message,
    };
    report.unknowns.push(
      "The remaining planned operations were not completed; retained earlier facts do not establish the unfinished goal.",
    );
    if (report.effects.launch_attempted)
      report.unknowns.push(
        "The app may remain open or continue network activity after interruption; this workflow does not force-stop it.",
      );
  } finally {
    if (runner) {
      try {
        report.unresolved_cleanup_owners = await runner.cleanup();
      } catch (error) {
        report.unresolved_cleanup_owners = 1;
        report.cleanup.push({ status: "incomplete", reason: error.message });
      }
    }
    if (report.unresolved_cleanup_owners > 0) {
      report.status = "cleanup_incomplete";
      report.unknowns.push(
        "Owned subprocess cleanup did not complete; inspect cleanup diagnostics before retrying.",
      );
    }
    report.finished_at = new Date().toISOString();
    report.elapsed_ms = Math.round(performance.now() - started);
    await checkpoint();
  }
  return report;
}
