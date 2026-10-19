import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseOptions } from "../src/options.mjs";
import { executeTask } from "../src/task.mjs";

// SIMULATED ADB PROVIDER: all tasks below invoke the real compiled REA CLI.
// These tests do not establish behavior on an Android device or television.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../bin/device-tasks.mjs", import.meta.url));
const exec = promisify(execFile);
let ownershipUnavailable = null;
try {
  const { prepareProcessOwnershipInspection } =
    await import("../../../dist/process/ProcessOwnershipObservation.js");
  await prepareProcessOwnershipInspection();
} catch (error) {
  if (!/process.ownership|procps|lookup self/iu.test(error.message))
    throw error;
  if (process.env.REA_DEVICE_TASK_REQUIRE_BOUNDARY === "1") throw error;
  ownershipUnavailable = error.message;
}
const boundary = { skip: ownershipUnavailable ?? false };
const fakeAdb = `#!${process.execPath}
import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root = dirname(process.argv[1]);
const scenario = readFileSync(join(root,'scenario'),'utf8');
const args = process.argv.slice(2).map(s => s.startsWith("'") && s.endsWith("'") ? s.slice(1,-1) : s);
appendFileSync(join(root,'calls'),JSON.stringify(args)+'\\n');
const out = (s) => process.stdout.write(s);
if(args[0]==='version') out('Android Debug Bridge version 1.0.41\\nVersion 34.0.5-simulated-provider\\nInstalled as '+process.argv[1]+'\\n');
else if(args[0]==='devices') out('List of devices attached\\n'+(scenario==='device-mismatch'?'other-device':'test-tv')+' '+(scenario==='unauthorized'?'unauthorized':'device')+' product:simulated model:simulated device:simulated transport_id:1\\n');
else if(args[0]!=='-s'||args[1]!=='test-tv') {out('error: device not found\\n');process.exitCode=1;}
else {
 const cmd=args.slice(3);
 if(cmd[0]==='getprop') out('[ro.build.version.release]: [14]\\n[ro.build.version.sdk]: [34]\\n[ro.product.model]: [Simulated TV]\\n');
 else if(cmd[0]==='pm'&&cmd[1]==='list') out('package:/data/app/example/base.apk:'+ (scenario==='missing-package'?'com.other':'com.example.app')+'\\n');
 else if(cmd[0]==='dumpsys'&&cmd[1]==='package') out('Package [com.example.app] (abc):\\n    userId=10123\\n    versionCode=1 minSdk=21 targetSdk=34\\n    versionName=1.0\\n');
 else if(cmd[0]==='wm'&&cmd[1]==='size') out('Physical size: 1920x1080\\n');
 else if(cmd[0]==='wm'&&cmd[1]==='density') out('Physical density: 160\\n');
 else if(cmd[0]==='cmd'&&cmd[1]==='package') out('com.example.app/.MainActivity\\n');
 else if(cmd[0]==='am'&&cmd[1]==='start') {
  writeFileSync(join(root,'launched'),'yes');
  if(scenario==='launch-failure') out('Error: Activity class does not exist.\\n');
  else out('Starting: Intent { cmp=com.example.app/.MainActivity }\\nStatus: ok\\nLaunchState: COLD\\nActivity: com.example.app/.MainActivity\\nTotalTime: 10\\nWaitTime: 11\\nComplete\\n');
 }
 else if(cmd[0]==='dumpsys'&&cmd[1]==='window') {
  const launched=existsSync(join(root,'launched'));
  if(launched&&(scenario==='hang'||scenario==='cancel')) {process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
  else {
   const counter=join(root,'observations');
   const count=launched?(existsSync(counter)?Number(readFileSync(counter,'utf8')):0)+1:0;
   if(launched)writeFileSync(counter,String(count));
   const pkg=!launched?'com.home':scenario==='wrong-focus'?'com.example.app.extra':scenario==='late-focus'&&count<3?'com.home':'com.example.app';
   out('mCurrentFocus=Window{abc u0 '+pkg+'/.MainActivity}\\nmFocusedApp=ActivityRecord{abc u0 com.example.app/.MainActivity t1}\\n');
  }
 }
 else if(args[2]==='exec-out'&&args[3]==='screencap') process.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k2S8AAAAASUVORK5CYII=','base64'));
 else {out('unexpected simulated adb arguments '+JSON.stringify(args)+'\\n');process.exitCode=1;}
}
`;

async function fixture(t, scenario) {
  const directory = await mkdtemp(path.join(tmpdir(), "rea-device-tasks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "adb.mjs"), fakeAdb, { mode: 0o755 });
  await writeFile(path.join(directory, "scenario"), scenario);
  const previous = process.env.REA_ADB_PATH;
  process.env.REA_ADB_PATH = path.join(directory, "adb.mjs");
  t.after(() => {
    if (previous === undefined) delete process.env.REA_ADB_PATH;
    else process.env.REA_ADB_PATH = previous;
  });
  const options = (extra = []) =>
    parseOptions([
      "open",
      "--serial",
      "test-tv",
      "--package",
      "com.example.app",
      "--output",
      path.join(directory, "report"),
      "--interval-ms",
      "5",
      ...extra,
    ]);
  const calls = async () =>
    (await readFile(path.join(directory, "calls"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  return { directory, options, calls };
}

test("dry-run is a process-free, write-free conditional plan, including URL and selected component", async (t) => {
  const f = await fixture(t, "success");
  const options = f.options([
    "--component",
    "com.example.app/.MainActivity",
    "--url",
    "https://example.com/a?b=c",
    "--dry-run",
    "--rea",
    path.join(f.directory, "missing-rea"),
  ]);
  const report = await executeTask(options);
  assert.equal(report.dry_run, true);
  assert.equal(
    report.conditional_plan.some(
      (c) =>
        c[0] === "start-adb-activity" &&
        c.includes("https://example.com/a?b=c"),
    ),
    true,
  );
  await assert.rejects(stat(path.join(f.directory, "calls")), {
    code: "ENOENT",
  });
  await assert.rejects(stat(options.output), { code: "ENOENT" });
  const output = await exec(
    process.execPath,
    [
      cli,
      "open",
      "--serial",
      "test-tv",
      "--package",
      "com.example.app",
      "--dry-run",
    ],
    { cwd: root },
  );
  assert.equal(JSON.parse(output.stdout).dry_run, true);
});

test("fixed task input rejects implicit targets, cross-package components and unbounded waits", () => {
  for (const args of [
    ["open", "--serial", "test-tv", "--dry-run"],
    ["inspect", "--dry-run"],
    [
      "open",
      "--serial",
      "test-tv",
      "--package",
      "com.example.app",
      "--component",
      "com.other/.Main",
      "--dry-run",
    ],
    [
      "open",
      "--serial",
      "test-tv",
      "--package",
      "com.example.app",
      "--url",
      "https://example.com",
      "--dry-run",
    ],
    [
      "open",
      "--serial",
      "test-tv",
      "--package",
      "com.example.app",
      "--component",
      "com.example.app/.Main",
      "--url",
      "file:///etc/hosts",
      "--dry-run",
    ],
    ["inspect", "--serial", "test-tv", "--attempts", "1000", "--dry-run"],
  ])
    assert.throws(() => parseOptions(args));
});

test(
  "one launch followed by late current focus retains complete authenticated REA Evidence and reports",
  boundary,
  async (t) => {
    const f = await fixture(t, "late-focus");
    const report = await executeTask(f.options(["--capture-screen"]));
    assert.equal(report.status, "verified_focus", JSON.stringify(report.error));
    assert.equal(report.focus_observations.length, 3);
    assert.equal(
      (await f.calls()).filter((a) => a[3] === "am" && a[4] === "start").length,
      1,
    );
    assert.equal(report.evidence.length, report.calls.length);
    for (const item of report.evidence) {
      const envelope = JSON.parse(
        await readFile(path.join(f.directory, "report", item.file), "utf8"),
      );
      assert.deepEqual(envelope.data, item.record);
      assert.equal(item.record.provider.id, "adb");
    }
    for (const name of [
      "report.json",
      "report.md",
      "report.html",
      "screens/before/screen.png",
      "screens/after/screen.png",
    ])
      assert.ok((await stat(path.join(f.directory, "report", name))).size > 0);
    const html = await readFile(
      path.join(f.directory, "report/report.html"),
      "utf8",
    );
    assert.equal(/<script|https?:\/\/[^<]*\.css/u.test(html), false);
    assert.match(report.unknowns.join(" "), /playback/u);
  },
);

test(
  "focused-app declaration and package prefixes do not substitute for exact current focus",
  boundary,
  async (t) => {
    const f = await fixture(t, "wrong-focus");
    const report = await executeTask(f.options(["--attempts", "2"]));
    assert.equal(report.status, "not_verified", JSON.stringify(report.error));
    assert.equal(report.focus_observations[0].package, "com.example.app.extra");
    assert.equal((await f.calls()).filter((a) => a[3] === "am").length, 1);
  },
);

for (const [scenario, code] of [
  ["unauthorized", "device_not_ready"],
  ["device-mismatch", "device_mismatch"],
  ["missing-package", "package_not_established"],
  ["launch-failure", "unsupported_target"],
]) {
  test(
    `${scenario} fails closed and retains earlier facts`,
    boundary,
    async (t) => {
      const f = await fixture(t, scenario);
      const report = await executeTask(f.options());
      assert.equal(report.status, "failed");
      assert.equal(report.error.code, code, JSON.stringify(report.error));
      assert.ok(report.facts.length > 0);
      const calls = await f.calls();
      assert.equal(
        calls.filter((a) => a[3] === "am").length,
        scenario === "launch-failure" ? 1 : 0,
      );
      assert.equal(
        JSON.parse(
          await readFile(path.join(f.directory, "report/report.json"), "utf8"),
        ).status,
        "failed",
      );
    },
  );
}

test(
  "per-call timeout stops a hung provider and preserves complete previous Evidence",
  boundary,
  async (t) => {
    const f = await fixture(t, "hang");
    const started = performance.now();
    const report = await executeTask(f.options(["--call-timeout-ms", "3000"]));
    assert.equal(report.status, "failed", JSON.stringify(report.error));
    assert.equal(report.calls.at(-1).error.code, "timeout");
    assert.ok(report.evidence.length > 0);
    assert.ok(performance.now() - started < 30000);
  },
);

test(
  "cancellation after launch preserves prior facts and prevents further observations or relaunch",
  boundary,
  async (t) => {
    const f = await fixture(t, "cancel");
    const controller = new AbortController();
    const pending = executeTask(f.options(), { signal: controller.signal });
    const deadline = performance.now() + 30000;
    while (true) {
      try {
        await stat(path.join(f.directory, "launched"));
        break;
      } catch {}
      assert.ok(performance.now() < deadline, "launch barrier deadline");
      await delay(30);
    }
    await delay(300);
    controller.abort();
    const report = await pending;
    assert.equal(report.status, "cancelled", JSON.stringify(report.error));
    assert.ok(report.evidence.length > 0);
    assert.equal((await f.calls()).filter((a) => a[3] === "am").length, 1);
    assert.match(report.unknowns.join(" "), /may remain open/u);
  },
);

test("existing report directory is refused before any provider call", async (t) => {
  const f = await fixture(t, "success");
  const options = f.options();
  options.output = f.directory;
  await assert.rejects(executeTask(options), { code: "EEXIST" });
  await assert.rejects(stat(path.join(f.directory, "calls")), {
    code: "ENOENT",
  });
});

test(
  "actual product CLI inspect emits usable reports for selected simulated device",
  boundary,
  async (t) => {
    const f = await fixture(t, "success");
    const output = await exec(
      process.execPath,
      [
        cli,
        "inspect",
        "--serial",
        "test-tv",
        "--output",
        path.join(f.directory, "report"),
      ],
      { cwd: root, timeout: 30000 },
    );
    assert.equal(JSON.parse(output.stdout).status, "inspected");
    assert.equal(
      (await f.calls()).some((a) => a[3] === "am"),
      false,
    );
  },
);

test(
  "unavailable process ownership produces a retained host-prerequisite refusal before ADB contact",
  { skip: ownershipUnavailable === null },
  async (t) => {
    const f = await fixture(t, "success");
    const report = await executeTask(f.options());
    assert.equal(report.status, "failed");
    assert.match(
      report.error.message,
      /process.ownership|procps|prepare_owned_process/iu,
    );
    assert.equal(report.calls.length, 1);
    assert.equal(report.calls[0].status, "failed");
    await assert.rejects(stat(path.join(f.directory, "calls")), {
      code: "ENOENT",
    });
    assert.equal(
      JSON.parse(
        await readFile(path.join(f.directory, "report/report.json"), "utf8"),
      ).status,
      "failed",
    );
  },
);
