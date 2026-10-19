import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEvidence } from "../../../dist/domain/evidence.js";
import { adbResultSchemas } from "../../../dist/domain/adb/adbDeviceAnalysis.js";
import { AnalysisCapabilityUnavailableError } from "../../../dist/domain/analysisErrorCore.js";
import { createRunner } from "../src/rea-runner.mjs";

// Injected process snapshots only: real Evidence hashing/schema validation is
// exercised, but no test here launches REA, ADB or a device subprocess.
const serial = "selected-tv";
const packageName = "com.example.app";
const component = `${packageName}/.MainActivity`;
const url = "https://example.test/video?local=evidence#keep";
const client = {
  binary_path: "/simulated/adb",
  path_source: "environment",
  version: "test",
  installed_path: "/simulated/adb",
};
const provider = {
  id: "adb",
  name: "Simulated ADB for runner unit tests",
  version: "test",
};

function evidence(
  operation = "inspect_adb_device",
  parameters = { serial },
  result,
) {
  const defaults = {
    inspect_adb_device: {
      client,
      serial,
      properties: [],
      property_count: 0,
      emulator_observed: null,
    },
    list_adb_packages: {
      client,
      serial,
      scope: "all",
      packages: [],
      unparsed_lines: [],
      coverage: "complete",
    },
    capture_adb_screen: {
      client,
      serial,
      local_path: "/selected/capture/screen.png",
      bytes: 1,
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
    },
    inspect_adb_package: {
      client,
      serial,
      package_name: packageName,
      version_name: null,
      version_code: null,
      first_install_time: null,
      last_update_time: null,
      installer_package_name: null,
      user_id: null,
      pkg_flags: null,
      requested_permissions_count: null,
      coverage: "complete",
    },
    start_adb_app: {
      client,
      serial,
      package_name: packageName,
      component,
      started_activity: `cmp=${component}`,
      reported_activity: component,
      reported_status: "ok",
    },
    start_adb_activity: {
      client,
      serial,
      action: "android.intent.action.VIEW",
      data_uri: url,
      component,
      extras: [],
      started_activity: `act=android.intent.action.VIEW cmp=${component}`,
      reported_activity: component,
      reported_status: "ok",
    },
  };
  const normalized = adbResultSchemas[operation].parse(
    result ?? defaults[operation],
  );
  return createEvidence(undefined, provider, {
    operation,
    parameters,
    result: normalized,
    subjectUnavailableReason:
      "Simulated unit-test observation; no device was contacted.",
  });
}

function snapshot(document, changes = {}) {
  const stdout =
    typeof document === "string" ? document : `${JSON.stringify(document)}\n`;
  return {
    stdout: {
      text: stdout,
      bytes: Buffer.byteLength(stdout),
      observedBytes: Buffer.byteLength(stdout),
    },
    stderr: { text: "", bytes: 0, observedBytes: 0 },
    exitCode: 0,
    signal: null,
    ...changes,
  };
}

async function fixture(t, runCommand) {
  const output = await mkdtemp(path.join(tmpdir(), "rea-runner-boundary-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await mkdir(path.join(output, "evidence"));
  const report = { calls: [], evidence: [], cleanup: [] };
  const options = {
    output,
    serial,
    package: packageName,
    component,
    url,
    rea: "/simulated/rea.mjs",
    callTimeoutMs: 1000,
  };
  const runner = await createRunner(
    options,
    report,
    async () => {},
    new AbortController().signal,
    { runCommand },
  );
  return {
    output,
    report,
    runner,
    returned: async (call = 0) =>
      readFile(path.join(output, report.calls[call].file), "utf8"),
  };
}

test("injected complete snapshot retains exact document and authenticated selected-device Evidence", async (t) => {
  const record = evidence();
  const text = `  ${JSON.stringify({ ok: true, data: record })}\n`;
  let launch;
  const f = await fixture(t, async (spawn) => {
    launch = spawn;
    return snapshot(text);
  });
  const result = await f.runner.run(["inspect-adb-device", serial]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.evidence, record);
  assert.equal(f.report.evidence[0].request_binding, "matched");
  assert.equal(await f.returned(), text);
  assert.deepEqual(launch.arguments, [
    "/simulated/rea.mjs",
    "inspect-adb-device",
    serial,
    "--format",
    "json",
    "--full-output",
  ]);
  assert.equal(
    launch.sweepTokenOwnedProcesses,
    undefined,
    "ordinary completed ADB server lifetime must not use a global detached-token sweep",
  );
  assert.equal(await f.runner.cleanup(), 0);
});

for (const [name, operation, parameters, result, args] of [
  [
    "different normalized serial",
    "inspect_adb_device",
    { serial },
    { ...evidence().normalized_result, serial: "other-tv" },
    ["inspect-adb-device", serial],
  ],
  [
    "different parameter serial",
    "inspect_adb_device",
    { serial: "other-tv" },
    undefined,
    ["inspect-adb-device", serial],
  ],
  [
    "omitted parameter serial",
    "inspect_adb_device",
    {},
    undefined,
    ["inspect-adb-device", serial],
  ],
  [
    "different requested package",
    "inspect_adb_package",
    { serial, package: "com.other" },
    undefined,
    ["inspect-adb-package", serial, packageName],
  ],
  [
    "different normalized package",
    "start_adb_app",
    { serial, package: packageName },
    {
      ...evidence("start_adb_app", { serial, package: packageName })
        .normalized_result,
      package_name: "com.other",
    },
    ["start-adb-app", serial, packageName],
  ],
  [
    "different intent action",
    "start_adb_activity",
    {
      serial,
      action: "android.intent.action.MAIN",
      component,
      data_uri: url,
      extras: [],
    },
    undefined,
    [
      "start-adb-activity",
      serial,
      "android.intent.action.VIEW",
      "--component",
      component,
      "--data-uri",
      url,
    ],
  ],
  [
    "different intent component",
    "start_adb_activity",
    {
      serial,
      action: "android.intent.action.VIEW",
      component: `${packageName}/.Other`,
      data_uri: url,
      extras: [],
    },
    undefined,
    [
      "start-adb-activity",
      serial,
      "android.intent.action.VIEW",
      "--component",
      component,
      "--data-uri",
      url,
    ],
  ],
  [
    "different intent URL",
    "start_adb_activity",
    {
      serial,
      action: "android.intent.action.VIEW",
      component,
      data_uri: "https://other.test/",
      extras: [],
    },
    undefined,
    [
      "start-adb-activity",
      serial,
      "android.intent.action.VIEW",
      "--component",
      component,
      "--data-uri",
      url,
    ],
  ],
]) {
  test(`injected authenticated Evidence with ${name} is retained but cannot satisfy request`, async (t) => {
    const record = evidence(operation, parameters, result);
    const text = `${JSON.stringify({ ok: true, data: record })}\n`;
    const f = await fixture(t, async () => snapshot(text));
    const returned = await f.runner.run(args);
    assert.equal(returned.ok, false);
    assert.equal(returned.error.code, "evidence_contract");
    assert.equal(returned.result, null);
    assert.equal(f.report.evidence.length, 1);
    assert.equal(f.report.evidence[0].request_binding, "unresolved");
    assert.deepEqual(f.report.evidence[0].record, record);
    assert.equal(await f.returned(), text);
  });
}

test("injected complete snapshot with a tampered semantic digest never becomes authenticated Evidence", async (t) => {
  const record = structuredClone(evidence());
  record.normalized_result.serial = "changed-after-hash";
  const text = `${JSON.stringify({ ok: true, data: record })}\n`;
  const f = await fixture(t, async () => snapshot(text));
  const result = await f.runner.run(["inspect-adb-device", serial]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "evidence_contract");
  assert.equal(f.report.evidence.length, 0);
  assert.equal(await f.returned(), text);
});

test("injected exact explicit intent binds action, component, original URL and empty extras", async (t) => {
  const record = evidence("start_adb_activity", {
    serial,
    action: "android.intent.action.VIEW",
    component,
    data_uri: url,
    extras: [],
  });
  const f = await fixture(t, async () => snapshot({ ok: true, data: record }));
  const result = await f.runner.run([
    "start-adb-activity",
    serial,
    "android.intent.action.VIEW",
    "--component",
    component,
    "--data-uri",
    url,
  ]);
  assert.equal(result.ok, true);
  assert.equal(f.report.evidence[0].request_binding, "matched");
  assert.equal(result.result.data_uri, url);
});

for (const [name, operation, parameters, normalized, args] of [
  [
    "unrequested intent extras",
    "start_adb_activity",
    {
      serial,
      action: "android.intent.action.VIEW",
      component,
      data_uri: url,
      extras: [{ key: "unrequested", type: "string", value: "value" }],
    },
    undefined,
    [
      "start-adb-activity",
      serial,
      "android.intent.action.VIEW",
      "--component",
      component,
      "--data-uri",
      url,
    ],
  ],
  [
    "different inventory scope",
    "list_adb_packages",
    { serial, scope: "system" },
    undefined,
    ["list-adb-packages", serial],
  ],
  [
    "different capture directory",
    "capture_adb_screen",
    { serial, output_directory: "/other/capture" },
    undefined,
    ["capture-adb-screen", serial, "--output-directory", "/selected/capture"],
  ],
  [
    "different captured file directory",
    "capture_adb_screen",
    { serial, output_directory: "/selected/capture" },
    {
      ...evidence("capture_adb_screen", {
        serial,
        output_directory: "/selected/capture",
      }).normalized_result,
      local_path: "/other/capture/screen.png",
    },
    ["capture-adb-screen", serial, "--output-directory", "/selected/capture"],
  ],
]) {
  test(`injected Evidence with ${name} cannot satisfy the fixed request`, async (t) => {
    const record = evidence(operation, parameters, normalized);
    const f = await fixture(t, async () =>
      snapshot({ ok: true, data: record }),
    );
    const result = await f.runner.run(args);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "evidence_contract");
    assert.equal(f.report.evidence[0].request_binding, "unresolved");
    assert.deepEqual(f.report.evidence[0].record, record);
  });
}

test("injected canonical capability failure uses the shared AnalysisError projection", async (t) => {
  const f = await fixture(t, async () => {
    throw new AnalysisCapabilityUnavailableError(
      "process-ownership",
      "prepare_owned_process",
      "Simulated procps unavailable",
    );
  });
  const result = await f.runner.run(["inspect-adb-device", serial]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "capability_unavailable");
  assert.equal(result.error.category, "unsupported_provider");
  assert.equal(result.error.details.provider_id, "process-ownership");
  assert.equal(result.error.details.operation, "prepare_owned_process");
  assert.equal(result.error.details.reason, "Simulated procps unavailable");
  assert.notEqual(result.error.code, "Simulated procps unavailable");
  assert.match(f.report.calls[0].file, /\.partial\.txt$/u);
});

test("injected arbitrary process error reason never becomes a public error code", async (t) => {
  const f = await fixture(t, async () => {
    throw Object.assign(new Error("Simulated process failure"), {
      reason: "arbitrary diagnostic",
    });
  });
  const result = await f.runner.run(["inspect-adb-device", serial]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "process_error");
});

test("injected successful Evidence with nonzero process exit remains retained without reporting success", async (t) => {
  const record = evidence();
  const f = await fixture(t, async () =>
    snapshot({ ok: true, data: record }, { exitCode: 7 }),
  );
  const result = await f.runner.run(["inspect-adb-device", serial]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "process_exit");
  assert.equal(f.report.calls[0].exit_code, 7);
  assert.equal(f.report.evidence[0].record.evidence_id, record.evidence_id);
  assert.equal(f.report.evidence[0].request_binding, "matched");
});

test("injected refusal retains exact partial observation and error diagnostics", async (t) => {
  const partial = evidence("start_adb_app", {
    serial,
    package: packageName,
  }).normalized_result;
  partial.started_activity = null;
  partial.reported_status = "timeout";
  const refusal = {
    ok: false,
    error: {
      code: "unsupported_target",
      message: "Simulated launch refusal",
      partial_observation: {
        provider_id: "adb",
        operation: "start_adb_app",
        result: partial,
      },
    },
  };
  const text = `${JSON.stringify(refusal, null, 2)}\n`;
  const f = await fixture(t, async () => snapshot(text, { exitCode: 1 }));
  const result = await f.runner.run(["start-adb-app", serial, packageName]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, refusal.error);
  assert.equal(f.report.evidence.length, 0);
  assert.equal(await f.returned(), text);
});

for (const [name, changes] of [
  ["truncated diagnostics", { diagnosticTruncated: true }],
  ["incomplete output stream", { outputIncomplete: true }],
  ["invalid UTF-8 stdout", { invalidStdout: true }],
]) {
  test(`injected ${name} is retained as partial output without Evidence promotion`, async (t) => {
    const text = '{"ok":true,"data":';
    const value = snapshot(text, changes);
    if (changes.invalidStdout) value.stdout.invalidUtf8 = true;
    const f = await fixture(t, async () => value);
    const result = await f.runner.run(["inspect-adb-device", serial]);
    assert.equal(result.ok, false);
    assert.equal(f.report.calls[0].output_complete, false);
    assert.match(f.report.calls[0].file, /\.partial\.txt$/u);
    assert.equal(f.report.evidence.length, 0);
    assert.equal(await f.returned(), text);
  });
}

test("injected process timeout keeps retained partial output and failure reason", async (t) => {
  const text = "retained before timeout";
  const f = await fixture(t, async () => {
    throw Object.assign(new Error("Simulated deadline"), {
      reason: "timeout",
      snapshot: snapshot(text, {
        outputIncomplete: true,
        exitCode: null,
        signal: "SIGTERM",
      }),
    });
  });
  const result = await f.runner.run(["inspect-adb-device", serial]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
  assert.equal(f.report.calls[0].signal, "SIGTERM");
  assert.equal(await f.returned(), text);
});

for (const [name, text] of [
  ["invalid JSON", "unstructured provider output"],
  ["empty JSON output", ""],
]) {
  test(`injected ${name} never masquerades as a complete REA document`, async (t) => {
    const f = await fixture(t, async () => snapshot(text));
    const result = await f.runner.run(["inspect-adb-device", serial]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid_json");
    assert.equal(f.report.calls[0].output_complete, false);
    assert.match(f.report.calls[0].file, /\.partial\.txt$/u);
    assert.equal(f.report.evidence.length, 0);
    assert.equal(await f.returned(), text);
  });
}

test("injected unresolved owners all receive cleanup attempts despite one thrown stop", async (t) => {
  const attempted = [];
  let call = 0;
  const f = await fixture(t, async (_spawn, _limits, lifecycle) => {
    const ownerNumber = ++call;
    lifecycle.retainCleanup(
      {
        stop: async () => {
          attempted.push(ownerNumber);
          if (ownerNumber === 1) throw new Error("Simulated cleanup exception");
          return { status: "completed" };
        },
      },
      { status: "incomplete", reason: "Simulated retained owner" },
    );
    return snapshot({ ok: true, data: evidence() });
  });
  await f.runner.run(["inspect-adb-device", serial]);
  await f.runner.run(["inspect-adb-device", serial]);
  assert.equal(await f.runner.cleanup(), 1);
  assert.deepEqual(attempted, [1, 2]);
  assert.equal(f.report.cleanup.at(-1).status, "completed");
  assert.ok(
    f.report.cleanup.some(
      (item) => item.reason === "Simulated cleanup exception",
    ),
  );
});
