import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultRea = fileURLToPath(
  new URL("../../../scripts/rea.mjs", import.meta.url),
);
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/u;
const flags = new Set(["dry-run", "capture-screen"]);
const values = new Set([
  "serial",
  "package",
  "component",
  "url",
  "output",
  "rea",
  "attempts",
  "interval-ms",
  "call-timeout-ms",
  "task-timeout-ms",
]);

export const help = `Exploratory REA Device Tasks (source checkout only)
Usage: node products/device-tasks/bin/device-tasks.mjs inspect --serial SERIAL --output NEW_DIR [--package PACKAGE]
       node products/device-tasks/bin/device-tasks.mjs open --serial SERIAL --package PACKAGE --output NEW_DIR [--component PACKAGE/ACTIVITY] [--url HTTPS_URL]

--dry-run                 Print a conditional plan; no processes or file writes.
--capture-screen          Capture frames before/after open, or once for inspect.
--attempts N              Focus observations after launch, 1–10 (default 3).
--interval-ms N           Delay between observations, 0–5000 (default 500).
--call-timeout-ms N       Per REA process deadline, 100–90000 (default 60000).
--task-timeout-ms N       Whole task deadline, 100–600000 (default 240000).
--rea PATH                REA executable or .mjs/.js file (default checkout CLI).

open launches once. Success means the exact expected package has current focus
at one observation; URL handling, playback and app usability remain unknown.
--url requires an explicit component in the expected package. No adb connect,
installation, settings changes, generic shell commands or UI input is exposed.
`;

export function parseOptions(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h"))
    return { help: true };
  const [command, ...rest] = argv;
  if (!["inspect", "open"].includes(command))
    throw new Error("Command must be inspect or open.");
  const raw = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].startsWith("--") ? rest[i].slice(2) : "";
    if (!flags.has(key) && !values.has(key))
      throw new Error(`Unknown argument: ${rest[i]}`);
    if (Object.hasOwn(raw, key)) throw new Error(`Duplicate option: --${key}`);
    if (flags.has(key)) raw[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith("--") || value.includes("\0"))
        throw new Error(`--${key} requires a value.`);
      raw[key] = value;
    }
  }
  if (
    !raw.serial ||
    raw.serial.length > 256 ||
    !/^[^-\s"'\x00][^\s"'\x00]*$/u.test(raw.serial)
  )
    throw new Error(
      "An explicit valid --serial is required (never chooses the first device).",
    );
  if (
    raw.package &&
    (raw.package.length > 256 || !packagePattern.test(raw.package))
  )
    throw new Error("--package must be an exact Android package name.");
  if (command === "open" && !raw.package)
    throw new Error("open requires --package.");
  if (command === "inspect" && (raw.component || raw.url))
    throw new Error("--component and --url are open options.");
  if (raw.component) {
    const [pkg, activity, extra] = raw.component.split("/");
    if (
      raw.component.length > 512 ||
      pkg !== raw.package ||
      !activity ||
      extra !== undefined ||
      !/^\.?[A-Za-z_][A-Za-z0-9_.]*$/u.test(activity)
    )
      throw new Error(
        "--component must be PACKAGE/ACTIVITY in the exact expected package (maximum 512 characters).",
      );
  }
  if (raw.url) {
    let url;
    try {
      url = new URL(raw.url);
    } catch {
      throw new Error("--url must be an absolute HTTP(S) URL.");
    }
    if (
      raw.url.length > 2048 ||
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname ||
      /[\s\x00]/u.test(raw.url)
    )
      throw new Error(
        "--url must be an absolute HTTP(S) URL without whitespace (maximum 2048 characters).",
      );
    if (!raw.component)
      throw new Error(
        "--url requires --component so intent resolution cannot choose another app.",
      );
    if (url.username || url.password)
      throw new Error(
        "Credentialed HTTP(S) URLs are unsupported; omit URL username and password.",
      );
  }
  if (!raw.output && !raw["dry-run"])
    throw new Error("--output must name an absent report directory.");
  const integer = (name, fallback, min, max) => {
    const value = raw[name] === undefined ? fallback : Number(raw[name]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  return {
    command,
    serial: raw.serial,
    package: raw.package ?? null,
    component: raw.component ?? null,
    url: raw.url ?? null,
    output: raw.output ? path.resolve(raw.output) : null,
    rea: path.resolve(raw.rea ?? defaultRea),
    dryRun: raw["dry-run"] === true,
    captureScreen: raw["capture-screen"] === true,
    attempts: integer("attempts", 3, 1, 10),
    intervalMs: integer("interval-ms", 500, 0, 5000),
    callTimeoutMs: integer("call-timeout-ms", 60000, 100, 90000),
    taskTimeoutMs: integer("task-timeout-ms", 240000, 100, 600000),
  };
}

export function launchArguments(options) {
  if (!options.component)
    return ["start-adb-app", options.serial, options.package];
  return [
    "start-adb-activity",
    options.serial,
    options.url ? "android.intent.action.VIEW" : "android.intent.action.MAIN",
    "--component",
    options.component,
    ...(options.url ? ["--data-uri", options.url] : []),
  ];
}

export function planTask(options) {
  const serial = options.serial;
  const operations = [
    ["inspect-adb-client"],
    ["list-adb-devices"],
    ["inspect-adb-device", serial],
    ["list-adb-packages", serial],
    ...(options.package
      ? [["inspect-adb-package", serial, options.package]]
      : []),
    ["inspect-adb-display", serial],
    ["inspect-adb-window", serial],
    ...(options.captureScreen
      ? [
          [
            "capture-adb-screen",
            serial,
            "--output-directory",
            "<report>/screens/before",
          ],
        ]
      : []),
    ...(options.command === "open"
      ? [
          ["list-adb-devices"],
          launchArguments(options),
          ...Array.from({ length: options.attempts }, () => [
            "inspect-adb-window",
            serial,
          ]),
          ...(options.captureScreen
            ? [
                [
                  "capture-adb-screen",
                  serial,
                  "--output-directory",
                  "<report>/screens/after",
                ],
              ]
            : []),
        ]
      : []),
  ];
  return {
    exploratory: true,
    dry_run: true,
    selection: {
      serial,
      package: options.package,
      component: options.component,
      url: options.url,
    },
    goal:
      options.command === "open"
        ? "Exact expected package has current window focus at one observation"
        : "Collect selected-device readiness, package, display and focus Evidence",
    conditional_plan: operations.map((args) => [
      ...args,
      "--format",
      "json",
      "--full-output",
    ]),
    conditions: [
      "Device readiness must match the exact selected serial.",
      "open requires the exact installed package and rechecks readiness immediately before one launch.",
      "Only focus reads retry; stop on matching current focus or an execution error.",
      "All device commands are conditional on successful earlier prerequisites.",
    ],
    bounds: {
      attempts: options.attempts,
      interval_ms: options.intervalMs,
      call_timeout_ms: options.callTimeoutMs,
      task_timeout_ms: options.taskTimeoutMs,
      rea_output_bytes_per_call: 8388608,
      rea_output_bytes_per_task: 16777216,
    },
    unknowns: [
      "No live state is observed during dry-run.",
      "Playback, successful URL handling, app usability and focus after observation are not established.",
    ],
  };
}
