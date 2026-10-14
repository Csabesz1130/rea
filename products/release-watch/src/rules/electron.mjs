// Electron boundary rules: renderer-reachable process execution, new bridge
// APIs, webPreferences regressions and fuse regressions.
import {
  absencePhrase,
  cite,
  heuristic,
  maxSeverity,
  newFacts,
  reported,
} from "./shared.mjs";

const APP_SOURCE = "REA analyze_javascript_application";

const before = (a, b) =>
  a.line < b.line || (a.line === b.line && a.column <= b.column);
const within = (inner, outer) =>
  before(outer.start, inner.start) && before(inner.end, outer.end);

/**
 * The read, inside the handler's source range, of a binding the handler's
 * module imports from `targetModule`. Null when REA facts do not connect them.
 */
const handlerReach = (app, handler, targetModule) => {
  const file = handler.location?.file ?? null;
  const range = handler.data.handler_range;
  if (file === null || range === null) return null;
  const imported = app.modules.get(file)?.imported ?? new Map();
  return (
    app.bindingReads.find(
      (read) =>
        read.data.module === file &&
        imported.get(read.data.name) === targetModule &&
        within(read.data.range, range),
    ) ?? null
  );
};

/**
 * A new renderer-exposed bridge member whose IPC handler lives in a module that
 * contains, or statically imports, a new process-execution site.
 */
export const rendererProcessExecution = (context) => {
  const { right, diff, labels } = context;
  const app = right.app;
  const findings = [];
  const coveredExec = new Set();
  const coveredMembers = new Set();
  if (!app) return { findings, coveredExec, coveredMembers };
  const handlers = new Map(
    app.ipcHandlers.map((handler) => [handler.data.channel, handler]),
  );
  const execSites = newFacts(diff.app.childProcesses);
  for (const { fact: member, status: memberStatus } of newFacts(
    diff.app.bridgeMembers,
  )) {
    const handler = handlers.get(member.data.channel);
    const handlerModule = handler?.location?.file ?? null;
    if (handlerModule === null) continue;
    for (const { fact: exec, status: execStatus } of execSites) {
      const execModule = exec.data.module;
      const read = handlerReach(app, handler, execModule);
      if (read === null) continue;
      coveredExec.add(exec.node_id);
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
          `The handler reads ${read.data.name}, which ${handlerModule} imports from ${execModule}; REA reports the import binding and the read, Release Watch connects them`,
          read.location,
        ),
        cite(
          `${exec.data.method}() creates a child process in ${execModule} (${absencePhrase(execStatus, labels.left)})`,
          exec,
          APP_SOURCE,
        ),
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
        title: `Renderer can reach new process execution via "${member.data.channel}"`,
        summary: `${labels.right} exposes ${member.data.member}() to web content; its handler module reaches ${exec.data.method}() in ${execModule}.`,
        why: "Any script running in the window, including injected content, could ask the main process to start programs with the user's privileges.",
        recommendation:
          "Ask the vendor why a renderer-exposed IPC channel can start processes, and require an allow-list of commands plus sender validation before deployment.",
        evidence,
        unknowns: [
          "REA did not establish that the IPC argument reaches the exec command; the path is an imported binding read inside the handler.",
        ],
      });
    }
  }
  return { findings, coveredExec, coveredMembers };
};

export const newProcessExecution = (context, coveredExec) =>
  newFacts(context.diff.app.childProcesses)
    .filter(({ fact }) => !coveredExec.has(fact.node_id))
    .map(({ fact, status }) => ({
      rule: "RW-P01",
      severity: "high",
      title: `New process execution: ${fact.data.method}() in ${fact.data.module}`,
      summary: `${context.labels.right} creates child processes from ${fact.data.module}.`,
      why: "Process execution is a common step in supply-chain payloads and widens what the app can do on endpoints.",
      recommendation:
        "Confirm the command source and that it cannot be influenced by web content or network data.",
      evidence: [
        cite(
          `${fact.data.method}() child-process creation (${absencePhrase(status, context.labels.left)})`,
          fact,
          APP_SOURCE,
        ),
      ],
      unknowns:
        fact.data.command === null
          ? ["REA did not resolve the command statically."]
          : [],
    }));

export const newBridgeMembers = (context, coveredMembers) =>
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

const preferenceRegressions = (before, after) =>
  Object.entries(WEB_PREFERENCES).flatMap(([name, rule]) => {
    const was = before[name] ?? { known: true, value: rule.safe };
    const now = after[name] ?? { known: true, value: rule.safe };
    if (!was.known || was.value !== rule.safe) return [];
    if (now.known && now.value === rule.safe) return [];
    return [{ name, rule, was, now }];
  });

export const webPreferenceRegressions = (context) =>
  context.diff.app.windows
    .filter((item) => item.status === "changed")
    .flatMap((item) => {
      const [before] = item.left;
      const [after] = item.right;
      return preferenceRegressions(
        before.data.web_preferences,
        after.data.web_preferences,
      ).map(({ name, rule, now }) => ({
        rule: "RW-E02",
        severity: now.known ? "high" : "medium",
        title: now.known
          ? `${rule.label} turned off (${name}: ${String(now.value)})`
          : `${rule.label} no longer statically known (${name})`,
        summary: `The BrowserWindow in ${item.key} changed ${name} from ${JSON.stringify(rule.safe)} to ${now.known ? JSON.stringify(now.value) : "a dynamic value"}.`,
        why: "This removes a layer that contains compromised or untrusted web content.",
        recommendation:
          "Ask the vendor to restore the setting or document the compensating control.",
        evidence: [
          cite(
            `${context.labels.left}: ${name} = ${JSON.stringify(rule.safe)}`,
            before,
            APP_SOURCE,
          ),
          cite(
            `${context.labels.right}: ${name} = ${now.known ? JSON.stringify(now.value) : String(now.value)}`,
            after,
            APP_SOURCE,
          ),
        ],
        unknowns: [
          "Static webPreferences do not prove runtime enforcement; code can still change them before window creation.",
        ],
      }));
    });

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

const implicationOutcome = (fuses, index) =>
  fuses.implications.find((implication) => implication.fuse_index === index)
    ?.outcome ?? null;

export const fuseRegressions = (context) => {
  const { left, right, diff } = context;
  if (!left.runtime?.fuses || !right.runtime?.fuses) return [];
  const rows = diff.fuses.filter(
    (change) => FUSES[change.name] && change.before === FUSES[change.name].safe,
  );
  if (rows.length === 0) return [];
  const unknowns = [];
  const severities = rows.map((change) => {
    if (change.name !== "EnableEmbeddedAsarIntegrityValidation")
      return FUSES[change.name].severity;
    if (implicationOutcome(right.runtime.fuses, 4) !== "unknown")
      return FUSES[change.name].severity;
    unknowns.push(
      "REA reports that embedded ASAR integrity is enforced only on macOS and Windows builds; on this Linux build the fuse byte does not establish enforcement either way.",
    );
    return "low";
  });
  return [
    {
      rule: "RW-E03",
      severity: maxSeverity(severities),
      title: `Electron hardening fuses removed (${rows.length})`,
      summary: `${right.runtime.name}: ${rows.map((row) => row.name).join(", ")} moved to their unsafe state.`,
      why: "Fuses are compiled-in switches that block well-known ways to run code inside a trusted, signed app. Losing them usually means the release pipeline changed.",
      recommendation:
        "Ask the vendor whether the build pipeline changed, and block until the fuses are restored.",
      evidence: rows.map((row, index) =>
        reported(
          `${row.name}: ${row.before} → ${row.after} (${severities[index]}). ${FUSES[row.name].meaning}`,
          "observed",
          "REA inspect_electron_fuses",
        ),
      ),
      unknowns: [
        ...unknowns,
        "Fuse state does not show whether the app enables these behaviours through other means.",
      ],
    },
  ];
};
