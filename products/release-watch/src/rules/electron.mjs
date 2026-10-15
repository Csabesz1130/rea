// Electron boundary rules: renderer-reachable process execution, new bridge
// APIs, webPreferences regressions and fuse regressions.
import { reachClaim, reachOf } from "./reach.mjs";
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  heuristic,
  maxSeverity,
  newFacts,
  newGroups,
  packResult,
  reported,
} from "./shared.mjs";

const FUSE_SOURCE = "REA inspect_electron_fuses";

const execEvidence = (group, labels) =>
  group.facts.map((exec) =>
    cite(
      `${exec.data.method}() creates a child process in ${exec.data.module}${exec.data.command ? "" : " with a command REA did not resolve"} (${group.status === "existing" ? `also in ${labels.left}` : absencePhrase(group.status, labels.left, group.counts)})`,
      exec,
      APP_SOURCE,
    ),
  );

/**
 * A new renderer-exposed bridge member whose IPC handler reaches a new,
 * added or changed process-execution site: one finding per channel and
 * exec key, citing every site of that key.
 */
const rendererProcessExecution = (context) => {
  const { right, diff, labels } = context;
  const app = right.app;
  const findings = [];
  const coveredExec = new Set();
  const coveredMembers = new Set();
  if (!app) return { findings, coveredExec, coveredMembers };
  const handlers = new Map(
    app.ipcHandlers.map((handler) => [handler.data.channel, handler]),
  );
  // New and changed exec sites, then existing ones: a new renderer API that
  // reaches an exec site the old release already had is still new reach.
  const fresh = newGroups(diff.app.childProcesses, { field: "command" });
  const freshKeys = new Set(fresh.map((group) => group.key));
  const groups = [
    ...fresh,
    ...diff.app.childProcesses
      .filter((item) => item.right.length > 0 && !freshKeys.has(item.key))
      .map((item) => ({
        key: item.key,
        status: "existing",
        counts: { before: item.left.length, after: item.right.length },
        facts: item.right,
        left: item.left,
      })),
  ];
  for (const { fact: member, status: memberStatus } of newFacts(
    diff.app.bridgeMembers,
  )) {
    const handler = handlers.get(member.data.channel);
    const scope = {
      module: handler?.location?.file ?? null,
      range: handler?.data.handler_range ?? null,
    };
    if (scope.module === null) continue;
    for (const group of groups) {
      const reached = group.facts
        .map((exec) => ({ exec, path: reachOf(app, scope, exec) }))
        .filter(({ path }) => path);
      if (reached.length === 0) continue;
      const [{ exec, path }] = reached;
      group.facts.forEach((fact) => coveredExec.add(fact.node_id));
      group.left.forEach((fact) => coveredExec.add(fact.node_id));
      coveredMembers.add(member.key);
      const evidence = [
        cite(
          `Renderer API ${member.data.member} invokes IPC channel "${member.data.channel}" (${absencePhrase(memberStatus, labels.left)})`,
          member,
          APP_SOURCE,
        ),
        cite(
          `Main-process handler for "${member.data.channel}"`,
          handler,
          APP_SOURCE,
        ),
        heuristic(
          reachClaim(path, exec, "the handler"),
          path.read?.location ?? exec.location,
        ),
        ...execEvidence(group, labels),
      ];
      if (app.summary?.sender_validation_observations === 0)
        evidence.push(
          reported(
            "REA observed no IPC sender validation in this release",
            "observed",
            APP_SOURCE,
          ),
        );
      findings.push({
        rule: "RW-E01",
        severity: "critical",
        title: `Renderer can reach ${group.status === "existing" ? "" : "new "}process execution via "${member.data.channel}"`,
        summary: `${labels.right} exposes ${member.data.member}() to web content; its handler reaches ${exec.data.method}() in ${exec.data.module}.`,
        why: "Any script running in the window, including injected content, could ask the main process to start programs with the user's privileges.",
        recommendation:
          "Ask the vendor why a renderer-exposed IPC channel can start processes, and require an allow-list of commands plus sender validation before deployment.",
        evidence,
        unknowns: [
          "REA did not establish that the IPC argument reaches the exec command; the path is a correlation of REA facts by location.",
        ],
      });
    }
  }
  return { findings, coveredExec, coveredMembers };
};

const newBridgeMembers = (context, coveredMembers) =>
  newFacts(context.diff.app.bridgeMembers)
    .filter(({ fact }) => !coveredMembers.has(fact.key))
    .map(({ fact, status }) => ({
      rule: "RW-E04",
      severity: "low",
      title: `New renderer API: ${fact.data.member}()`,
      summary: `Web content can now call ${fact.data.member}() over IPC channel "${fact.data.channel}".`,
      why: "Each bridge member is attack surface for script running in the window.",
      recommendation:
        "Expected for new features; review the handler if the feature is unfamiliar.",
      evidence: [
        cite(
          `${fact.data.member} invokes "${fact.data.channel}" (${absencePhrase(status, context.labels.left)})`,
          fact,
          APP_SOURCE,
        ),
      ],
      unknowns: [],
    }));

// Values Electron uses when the option is omitted (Electron 20 and later).
const WEB_PREFERENCES = {
  sandbox: { safe: true, label: "Renderer sandbox" },
  contextIsolation: { safe: true, label: "Context isolation" },
  nodeIntegration: {
    safe: false,
    label: "Node.js integration in the renderer",
  },
  nodeIntegrationInWorker: {
    safe: false,
    label: "Node.js integration in workers",
  },
  webSecurity: { safe: true, label: "Web security (same-origin policy)" },
  allowRunningInsecureContent: { safe: false, label: "Mixed-content blocking" },
};

// One window's setting of one preference: "default" when omitted.
const stateOf = (setting, rule) =>
  setting === null
    ? "default"
    : !setting.known
      ? "dynamic"
      : setting.value === rule.safe
        ? "safe"
        : "unsafe";

const settingText = (name, setting) =>
  setting === null
    ? `${name} omitted`
    : `${name} = ${setting.known ? JSON.stringify(setting.value) : `dynamic value ${setting.value ?? ""}`.trim()}`;

const windowFile = (window) => window.data.source_path ?? window.key;

// Windows by file, old files renamed to their new path.
const byFile = (windows, aliases = new Map()) => {
  const files = new Map();
  for (const window of windows) {
    const file = aliases.get(windowFile(window))?.path ?? windowFile(window);
    if (!files.has(file)) files.set(file, []);
    files.get(file).push(window);
  }
  return files;
};

const count = (windows, name, rule, state) =>
  windows.filter(
    (window) =>
      stateOf(window.data.web_preferences[name] ?? null, rule) === state,
  ).length;

// How the old release set the preference in this file: explicit values are
// REA facts, omitted values rely on Electron's documented default.
const beforeLines = (context, { name, rule, windows, file }) =>
  windows.length === 0
    ? [
        reported(
          `${context.labels.left}: REA reported no BrowserWindow in ${file}`,
          "derived",
          APP_SOURCE,
        ),
      ]
    : windows.map((window) => {
        const setting = window.data.web_preferences[name] ?? null;
        return setting === null
          ? heuristic(
              `${context.labels.left}: BrowserWindow in ${windowFile(window)} omits ${name}; Electron 20+ defaults it to ${JSON.stringify(rule.safe)}`,
              window.location,
              { side: "left" },
            )
          : cite(
              `${context.labels.left}: BrowserWindow in ${windowFile(window)}: ${settingText(name, setting)}`,
              window,
              APP_SOURCE,
              {
                side: "left",
              },
            );
      });

/**
 * Windows are paired by file (through module renames). A file whose windows
 * set the unsafe or a dynamic value more often than before is a regression;
 * a file that is new counts only when the component as a whole has more
 * such windows, so a window that moved file with its options is not new.
 */
const byLine = (windows) =>
  [...windows].sort(
    (a, b) => (a.location?.line ?? 0) - (b.location?.line ?? 0),
  );

/**
 * Regressing windows in one file. With as many windows as before, windows
 * pair by position, so a swap (one window made unsafe, another made safe)
 * is still seen. Otherwise windows are counted, and a file that gained
 * windows counts only when the component as a whole has more such windows,
 * so a window that moved in with its options is not new.
 */
const fileRegressions = (context, { name, rule, old, windows }) => {
  const { left, right } = context;
  const state = (window) =>
    stateOf(window.data.web_preferences[name] ?? null, rule);
  if (old.length === windows.length && old.length > 0) {
    const pairs = byLine(old).map((was, index) => [
      was,
      byLine(windows)[index],
    ]);
    const unsafe = pairs.filter(
      ([was, now]) => state(now) === "unsafe" && state(was) !== "unsafe",
    );
    if (unsafe.length > 0)
      return {
        known: true,
        offending: unsafe.map(([, now]) => now),
        oldDynamic: unsafe.some(([was]) => state(was) === "dynamic"),
      };
    const dynamic = pairs.filter(
      ([was, now]) =>
        state(now) === "dynamic" && !["dynamic", "unsafe"].includes(state(was)),
    );
    return dynamic.length > 0
      ? {
          known: false,
          offending: dynamic.map(([, now]) => now),
          oldDynamic: false,
        }
      : null;
  }
  const gained = windows.length > old.length;
  const grew = (target) =>
    count(windows, name, rule, target) > count(old, name, rule, target) &&
    (!gained ||
      count(right.app.windows, name, rule, target) >
        count(left.app.windows, name, rule, target));
  const known = grew("unsafe");
  if (!known && !grew("dynamic")) return null;
  return {
    known,
    offending: windows.filter(
      (window) => state(window) === (known ? "unsafe" : "dynamic"),
    ),
    oldDynamic: known && count(old, name, rule, "dynamic") > 0,
  };
};

const webPreferenceRegressions = (context) => {
  const { left, right } = context;
  if (!left.app || !right.app) return [];
  const before = byFile(left.app.windows, context.aliases);
  const after = byFile(right.app.windows);
  return Object.entries(WEB_PREFERENCES).flatMap(([name, rule]) =>
    [...after].flatMap(([file, windows]) => {
      const old = before.get(file) ?? [];
      const regression = fileRegressions(context, { name, rule, old, windows });
      if (regression === null) return [];
      const { known, offending, oldDynamic } = regression;
      const shown = offending[0].data.web_preferences[name];
      const verb = rule.safe === true ? "turned off" : "turned on";
      return [
        {
          rule: "RW-E02",
          severity: known && !oldDynamic ? "high" : "medium",
          title: known
            ? `${rule.label} ${verb} (${name}: ${JSON.stringify(shown.value)})`
            : `${rule.label} no longer statically known (${name})`,
          summary: `${offending.length} BrowserWindow${offending.length === 1 ? "" : "s"} in ${file} set ${name} to ${known ? "the unsafe value" : "a dynamic value"} in ${context.labels.right}, where ${context.labels.left} did not.`,
          why: "This removes a layer that contains compromised or untrusted web content.",
          recommendation:
            "Ask the vendor to restore the setting or document the compensating control.",
          evidence: [
            // A file new in this release is compared with the whole old release.
            ...beforeLines(context, {
              name,
              rule,
              windows: old.length > 0 ? old : left.app.windows,
              file,
            }),
            ...offending.map((window) =>
              cite(
                `${context.labels.right}: BrowserWindow in ${file}: ${settingText(name, window.data.web_preferences[name] ?? null)}`,
                window,
                APP_SOURCE,
              ),
            ),
          ],
          unknowns: [
            "Static webPreferences do not prove runtime enforcement; code can still change them before window creation.",
            ...(oldDynamic
              ? [
                  `${context.labels.left} set ${name} to a dynamic value REA did not resolve, so the old state is not established.`,
                ]
              : []),
            ...(old.some(
              (window) => (window.data.web_preferences[name] ?? null) === null,
            )
              ? [
                  "Release Watch assumes Electron 20 or later defaults for omitted options; REA did not report the Electron version.",
                ]
              : []),
          ],
        },
      ];
    }),
  );
};

const FUSES = {
  RunAsNode: {
    safe: "disabled",
    severity: "high",
    meaning:
      "ELECTRON_RUN_AS_NODE turns the app's signed executable into a general Node.js runtime.",
  },
  EnableNodeCliInspectArguments: {
    safe: "disabled",
    severity: "high",
    meaning:
      "--inspect lets a local process attach a debugger and run code inside the app.",
  },
  EnableNodeOptionsEnvironmentVariable: {
    safe: "disabled",
    severity: "medium",
    meaning: "NODE_OPTIONS can preload arbitrary code at startup.",
  },
  OnlyLoadAppFromAsar: {
    safe: "enabled",
    severity: "medium",
    meaning:
      "The app may load code from a replaceable resources/app directory.",
  },
  EnableEmbeddedAsarIntegrityValidation: {
    safe: "enabled",
    severity: "medium",
    meaning: "Tampering with app.asar is no longer detected at startup.",
  },
  EnableCookieEncryption: {
    safe: "enabled",
    severity: "medium",
    meaning:
      "Cookies on disk are no longer encrypted with the OS credential store.",
  },
};

const isRead = (state) => state === "enabled" || state === "disabled";

const implicationOutcome = (fuses, index) =>
  fuses.implications.find((implication) => implication.fuse_index === index)
    ?.outcome ?? null;

// Severity of one fuse in its unsafe state; ASAR integrity is not enforced
// on Linux, which REA reports as an unknown outcome.
const fuseSeverity = (name, fuses, unknowns) => {
  if (
    name !== "EnableEmbeddedAsarIntegrityValidation" ||
    implicationOutcome(fuses, 4) !== "unknown"
  )
    return FUSES[name].severity;
  unknowns.add(
    "REA reports that embedded ASAR integrity is enforced only on macOS and Windows builds; on this Linux build the fuse byte does not establish enforcement either way.",
  );
  return "low";
};

/**
 * Fuses REA read as unsafe on a new executable, for every executable pair.
 * A fuse whose old state REA did not establish (several wires, no wire for
 * that fuse) is still reported when the new state is unsafe, at medium.
 */
const fuseRegressions = (context) =>
  context.diff.runtimes.flatMap((pair) => {
    const after = pair.after?.fuses;
    if (!after || after.ambiguous) return [];
    const before = pair.before?.fuses ?? null;
    // The old release had executables REA tried to read, without a result.
    const oldInspected = (context.left.runtimeStatus?.candidates ?? 0) > 0;
    const unknowns = new Set();
    const rows = Object.entries(FUSES).flatMap(([name, fuse]) => {
      const now = after.fuses[name];
      if (!isRead(now) || now === fuse.safe) return [];
      const was =
        before && !before.ambiguous
          ? (before.fuses[name] ?? "unknown")
          : "unknown";
      if (was !== fuse.safe && was !== "unknown") return [];
      if (before === null && !oldInspected) return [];
      const established = was === fuse.safe;
      return [
        {
          name,
          was,
          now,
          severity: established
            ? fuseSeverity(name, after, unknowns)
            : "medium",
          established,
        },
      ];
    });
    if (rows.length === 0) return [];
    if (rows.some((row) => !row.established))
      unknowns.add(
        before === null
          ? `REA could not read ${context.labels.left}'s fuses (${context.left.runtimeStatus.failures.length > 0 ? "the inspection failed" : "no fuse wire found"}), so the old state is not established.`
          : `REA did not establish the old state of every fuse in ${pair.before.name} (${before.ambiguous ? "several fuse wires" : "fuse missing"}).`,
      );
    const established = rows.every((row) => row.established);
    const where =
      pair.matched || pair.before === null
        ? pair.after.name
        : `${pair.after.name}, a new executable compared with ${pair.before.name}`;
    return [
      {
        rule: "RW-E03",
        severity: maxSeverity(rows.map((row) => row.severity)),
        title: `Electron hardening fuses ${established ? "removed" : "in the unsafe state"} (${rows.length})${pair.matched || pair.before === null ? "" : ` in new executable ${pair.after.name}`}`,
        summary: `${where}: ${rows.map((row) => row.name).join(", ")} ${rows.length === 1 ? "is" : "are"} in the unsafe state.`,
        why: "Fuses are compiled-in switches that block well-known ways to run code inside a trusted, signed app. Losing them usually means the release pipeline changed.",
        recommendation:
          "Ask the vendor whether the build pipeline changed, and block until the fuses are restored.",
        evidence: rows.map((row) =>
          reported(
            `${row.name}: ${row.was} → ${row.now} (${row.severity}). ${FUSES[row.name].meaning}`,
            "observed",
            FUSE_SOURCE,
          ),
        ),
        unknowns: [
          ...unknowns,
          "Fuse state does not show whether the app enables these behaviours through other means.",
        ],
      },
    ];
  });

/** Electron rules; claims the exec sites RW-E01 explains so RW-P01 skips them. */
export const electronPack = (context) => {
  const execution = rendererProcessExecution(context);
  return packResult(
    [
      ...execution.findings,
      ...webPreferenceRegressions(context),
      ...fuseRegressions(context),
      ...newBridgeMembers(context, execution.coveredMembers),
    ],
    { nodes: [...execution.coveredExec] },
  );
};
