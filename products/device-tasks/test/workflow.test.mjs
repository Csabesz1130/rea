import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseOptions } from "../src/options.mjs";
import { executeTask } from "../src/task.mjs";

// Process-free workflow semantics only. The injected runner below is simulated:
// it supplies no authenticated REA Evidence and proves no CLI, ADB or device behavior.
const serial = "selected-tv";
const expectedPackage = "com.example.app";
const client = { binary_path: "/simulated/adb", version: "simulated" };
const focus = (windowPackage, appPackage = windowPackage) => ({
  client,
  serial,
  focused_window:
    windowPackage === null
      ? null
      : `Window{abc u0 ${windowPackage}/.MainActivity}`,
  focused_app:
    appPackage === null
      ? null
      : `ActivityRecord{def u0 ${appPackage}/.MainActivity t1}`,
  observed_lines: [],
});

async function fixture(t, configuration = {}, extra = []) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "rea-workflow-semantics-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = parseOptions([
    "open",
    "--serial",
    serial,
    "--package",
    expectedPackage,
    "--output",
    path.join(directory, "report"),
    "--interval-ms",
    "0",
    ...extra,
  ]);
  const calls = [];
  let launches = 0;
  let observations = 0;
  let readinessReads = 0;
  let cleanupCalls = 0;
  let factoryCalls = 0;
  const runnerFactory = async (_options, report, _checkpoint, signal) => {
    factoryCalls++;
    return {
      run: async (args, label = args[0]) => {
        signal.throwIfAborted();
        const call = report.calls.length + 1;
        const command = args[0];
        calls.push([...args]);
        const record = {
          sequence: call,
          label,
          operation: command.replaceAll("-", "_"),
          status: "completed",
          elapsed_ms: 0,
          evidence_id: null,
        };
        report.calls.push(record);
        let result;
        if (command === "inspect-adb-client") result = { client };
        else if (command === "list-adb-devices") {
          readinessReads++;
          result = {
            client,
            devices: configuration.devices?.(readinessReads) ?? [
              { serial, state: "device" },
            ],
          };
        } else if (command === "inspect-adb-device")
          result = { client, serial, properties: [], property_count: 0 };
        else if (command === "list-adb-packages")
          result = {
            client,
            serial,
            coverage: "complete",
            packages: configuration.packages ?? [
              {
                package_name: expectedPackage,
                base_apk_device_path: "/data/app/base.apk",
              },
            ],
          };
        else if (command === "inspect-adb-package")
          result = { client, serial, package_name: expectedPackage };
        else if (command === "inspect-adb-display")
          result = {
            client,
            serial,
            physical_size: { width: 1920, height: 1080 },
          };
        else if (command === "inspect-adb-window") {
          if (launches === 0) result = focus("com.home");
          else {
            observations++;
            const values = configuration.focus ?? [focus(expectedPackage)];
            result = values[Math.min(observations - 1, values.length - 1)];
          }
        } else if (
          command === "start-adb-app" ||
          command === "start-adb-activity"
        ) {
          launches++;
          result = {
            client,
            serial,
            package_name: configuration.launchPackage ?? expectedPackage,
          };
        } else throw new Error(`Unexpected simulated operation: ${command}`);
        const failure = configuration.fail?.({
          command,
          launches,
          observations,
          readinessReads,
        });
        if (failure) {
          record.status = "failed";
          record.error = failure;
        }
        await configuration.onRun?.({
          command,
          launches,
          observations,
          readinessReads,
          signal,
        });
        return {
          ok: !failure,
          result: failure ? null : result,
          evidence: null,
          call,
          error: failure ?? null,
        };
      },
      cleanup: async () => {
        cleanupCalls++;
        report.cleanup.push(...(configuration.cleanupRecords ?? []));
        return configuration.unresolvedOwners ?? 0;
      },
    };
  };
  return {
    options,
    calls,
    runnerFactory,
    counts: () => ({
      launches,
      observations,
      readinessReads,
      cleanupCalls,
      factoryCalls,
    }),
    savedReport: async () =>
      JSON.parse(
        await readFile(path.join(options.output, "report.json"), "utf8"),
      ),
  };
}

for (const [name, devices, code] of [
  [
    "unauthorized selected serial",
    [{ serial, state: "unauthorized" }],
    "device_not_ready",
  ],
  [
    "another ready serial",
    [{ serial: "other-tv", state: "device" }],
    "device_mismatch",
  ],
  [
    "duplicate selected serial declarations",
    [
      { serial, state: "device" },
      { serial, state: "device" },
    ],
    "device_mismatch",
  ],
]) {
  test(`simulated workflow refuses ${name} before launch`, async (t) => {
    const f = await fixture(t, { devices: () => devices });
    const report = await executeTask(f.options, {
      runnerFactory: f.runnerFactory,
    });
    assert.equal(report.status, "failed");
    assert.equal(report.error.code, code);
    assert.equal(f.counts().launches, 0);
    assert.equal(report.effects.launch_attempted, false);
    assert.equal(f.counts().cleanupCalls, 1);
    assert.equal((await f.savedReport()).error.code, code);
  });
}

test("simulated workflow rechecks exact readiness immediately before its only launch", async (t) => {
  const f = await fixture(t, {
    devices: (read) => [{ serial, state: read === 1 ? "device" : "offline" }],
  });
  const report = await executeTask(f.options, {
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "device_not_ready");
  assert.equal(f.counts().readinessReads, 2);
  assert.equal(f.counts().launches, 0);
  assert.ok(
    report.facts.some((fact) =>
      fact.text.includes("installed-package inventory"),
    ),
  );
});

test("simulated late current focus retries observations without relaunching", async (t) => {
  const f = await fixture(t, {
    focus: [focus("com.home"), focus("com.home"), focus(expectedPackage)],
  });
  const report = await executeTask(f.options, {
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.status, "verified_focus");
  assert.equal(f.counts().launches, 1);
  assert.equal(f.counts().observations, 3);
  assert.equal(report.focus_observations.length, 3);
  assert.equal(report.focus_observations.at(-1).matches, true);
  assert.ok(
    report.facts.some(
      (fact) => fact.confidence === "derived" && fact.calls.length === 1,
    ),
  );
  assert.equal(
    report.evidence.length,
    0,
    "simulated runner must not invent authenticated Evidence",
  );
  assert.equal((await f.savedReport()).status, "verified_focus");
});

for (const [name, declaration] of [
  ["package-name prefix", focus(`${expectedPackage}.extra`, expectedPackage)],
  ["focused-app without current window", focus(null, expectedPackage)],
  ["conflicting focused app", focus(expectedPackage, "com.other")],
  [
    "unrecognized focused-app declaration",
    { ...focus(expectedPackage), focused_app: "unknown declaration" },
  ],
  ["another package", focus("com.other")],
]) {
  test(`simulated ${name} cannot verify exact current focus`, async (t) => {
    const f = await fixture(t, { focus: [declaration] }, ["--attempts", "2"]);
    const report = await executeTask(f.options, {
      runnerFactory: f.runnerFactory,
    });
    assert.equal(report.status, "not_verified");
    assert.equal(f.counts().launches, 1);
    assert.equal(f.counts().observations, 2);
    assert.equal(
      report.focus_observations.some((item) => item.matches),
      false,
    );
    assert.ok(
      report.unknowns.some((item) => item.includes("launch was not retried")),
    );
  });
}

test("simulated expected current window with absent focused-app declaration can verify", async (t) => {
  const f = await fixture(t, { focus: [focus(expectedPackage, null)] });
  const report = await executeTask(f.options, {
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.status, "verified_focus");
  assert.equal(f.counts().observations, 1);
});

test("simulated package inventory requires one exact package entry", async (t) => {
  const f = await fixture(t, {
    packages: [
      {
        package_name: `${expectedPackage}.extra`,
        base_apk_device_path: "/data/app/base.apk",
      },
    ],
  });
  const report = await executeTask(f.options, {
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "package_not_established");
  assert.equal(f.counts().launches, 0);
});

test("simulated launch refusal keeps earlier facts and never observes a completed launch", async (t) => {
  const f = await fixture(t, {
    fail: ({ command }) =>
      command === "start-adb-app"
        ? {
            code: "unsupported_target",
            message: "Simulated Activity Manager refusal",
          }
        : null,
  });
  const report = await executeTask(f.options, {
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "unsupported_target");
  assert.equal(f.counts().launches, 1);
  assert.equal(f.counts().observations, 0);
  assert.ok(report.facts.length > 0);
  assert.equal(report.focus_observations.length, 0);
  assert.ok(report.unknowns.some((item) => item.includes("may remain open")));
});

test("simulated launch of a different package is refused before verification", async (t) => {
  const f = await fixture(t, { launchPackage: "com.other" });
  const report = await executeTask(f.options, {
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.error.code, "package_mismatch");
  assert.equal(f.counts().observations, 0);
});

test("simulated cancellation after launch keeps facts and prevents further calls", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, {
    onRun: ({ command }) => {
      if (command === "start-adb-app") controller.abort();
    },
  });
  const report = await executeTask(f.options, {
    signal: controller.signal,
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.status, "cancelled");
  assert.equal(f.counts().launches, 1);
  assert.equal(f.counts().observations, 0);
  assert.equal(f.counts().cleanupCalls, 1);
  assert.ok(report.facts.length > 0);
  assert.equal((await f.savedReport()).status, "cancelled");
});

test("simulated whole-task deadline aborts the active workflow and still cleans up", async (t) => {
  const f = await fixture(
    t,
    {
      onRun: async ({ command, signal }) => {
        if (command === "inspect-adb-device")
          await delay(1000, undefined, { signal });
      },
    },
    ["--task-timeout-ms", "100"],
  );
  const report = await executeTask(f.options, {
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.status, "timeout");
  assert.equal(f.counts().launches, 0);
  assert.equal(f.counts().cleanupCalls, 1);
  assert.ok(report.facts.length > 0);
});

test("simulated aggregate unresolved cleanup overrides later completed cleanup", async (t) => {
  const f = await fixture(t, {
    cleanupRecords: [
      { call: 1, status: "incomplete", reason: "simulated unresolved owner" },
      { call: 2, status: "completed" },
    ],
    unresolvedOwners: 1,
  });
  const report = await executeTask(f.options, {
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.cleanup.at(-1).status, "completed");
  assert.equal(report.unresolved_cleanup_owners, 1);
  assert.equal(report.status, "cleanup_incomplete");
  assert.ok(
    report.unknowns.some((item) =>
      item.includes("Owned subprocess cleanup did not complete"),
    ),
  );
});

test("simulated dry-run never constructs runner or creates report directory", async (t) => {
  const f = await fixture(t, {}, ["--dry-run"]);
  const report = await executeTask(f.options, {
    runnerFactory: f.runnerFactory,
  });
  assert.equal(report.dry_run, true);
  assert.equal(f.counts().factoryCalls, 0);
  await assert.rejects(stat(f.options.output), { code: "ENOENT" });
});
