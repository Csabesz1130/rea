// Electron boundary rules: renderer-reachable process execution, new bridge
// APIs, webPreferences regressions and fuse regressions.
import {
  componentAbsence,
  heldElsewhere,
  perComponent,
  processAbsence,
} from "./component-absence.mjs";
import { reachOf } from "./reach.mjs";
import { reachClaim, reachUnknowns } from "./reach-text.mjs";
import { webPreferenceRegressions } from "./windows.mjs";
import {
  APP_SOURCE,
  cite,
  heuristic,
  maxSeverity,
  newFacts,
  newGroups,
  packResult,
  reported,
} from "./shared.mjs";

const FUSE_SOURCE = "REA inspect_electron_fuses";

// How the component's old side had a renderer API or an exec site, and
// whether another old component had what this one did not (`held`).
const memberAbsence = (context, { fact, status }) => {
  const held = heldElsewhere(context, "bridgeMembers", {
    key: fact.key,
    status,
  });
  return {
    held,
    phrase: componentAbsence(context, {
      status,
      held,
      had: "exposed an API of this name",
    }),
  };
};

const execAbsence = (context, group) =>
  group.status === "existing"
    ? { held: false, phrase: `also in ${context.labels.left}` }
    : processAbsence(context, group);

const execEvidence = (group, absence) =>
  group.facts.map((exec) =>
    cite(
      `${exec.data.method}() creates a child process in ${exec.data.module}${exec.data.command ? "" : " with a command REA did not resolve"} (${absence.phrase})`,
      exec,
      APP_SOURCE,
    ),
  );

const heldUnknowns = (member, exec) => [
  ...(member.held ? [perComponent("renderer APIs")] : []),
  ...(exec.held ? [perComponent("process execution sites")] : []),
];

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
  for (const added of newFacts(diff.app.bridgeMembers)) {
    const member = added.fact;
    const memberHeld = memberAbsence(context, added);
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
      const execHeld = execAbsence(context, group);
      const evidence = [
        cite(
          `Renderer API ${member.data.member} invokes IPC channel "${member.data.channel}" (${memberHeld.phrase})`,
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
        ...execEvidence(group, execHeld),
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
        summary: `${labels.right} exposes ${member.data.member}() to web content; its handler ${path.guess ? "may reach" : "reaches"} ${exec.data.method}() in ${exec.data.module}.`,
        why: "Any script running in the window, including injected content, could ask the main process to start programs with the user's privileges.",
        recommendation:
          "Ask the vendor why a renderer-exposed IPC channel can start processes, and require an allow-list of commands plus sender validation before deployment.",
        evidence,
        unknowns: [
          "REA did not establish that the IPC argument reaches the exec command; the path is a correlation of REA facts by location.",
          ...reachUnknowns([path]),
          ...heldUnknowns(memberHeld, execHeld),
        ],
      });
    }
  }
  return { findings, coveredExec, coveredMembers };
};

const MAX_LISTED = 25;

// RW-E04: one finding per component for the renderer APIs it adds, so a
// release that adds many does not bury the rest of the report.
const newBridgeMembers = (context, coveredMembers) => {
  const added = newFacts(context.diff.app.bridgeMembers).filter(
    ({ fact }) => !coveredMembers.has(fact.key),
  );
  if (added.length === 0) return [];
  const names = added.map(({ fact }) => `${fact.data.member}()`);
  const shown = names.slice(0, 3).join(", ");
  const absences = added.map((entry) => memberAbsence(context, entry));
  return [
    {
      rule: "RW-E04",
      severity: "low",
      title:
        added.length === 1
          ? `New renderer API: ${names[0]}`
          : `New renderer APIs (${added.length}): ${shown}${added.length > 3 ? ` and ${added.length - 3} more` : ""}`,
      summary:
        added.length === 1
          ? `Web content can now call ${names[0]} over IPC channel "${added[0].fact.data.channel}".`
          : `Web content can now call ${added.length} more functions over IPC.`,
      why: "Each bridge member is attack surface for script running in the window.",
      recommendation:
        "Expected for new features; review the handlers if a feature is unfamiliar.",
      evidence: [
        ...added
          .slice(0, MAX_LISTED)
          .map(({ fact }, index) =>
            cite(
              `${fact.data.member} invokes "${fact.data.channel}" (${absences[index].phrase})`,
              fact,
              APP_SOURCE,
            ),
          ),
        ...(added.length > MAX_LISTED
          ? [
              reported(
                `${added.length - MAX_LISTED} more renderer APIs are listed in the inventory`,
                "derived",
                APP_SOURCE,
              ),
            ]
          : []),
      ],
      unknowns: absences.some((absence) => absence.held)
        ? [perComponent("renderer APIs")]
        : [],
    },
  ];
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
const oldFuseGap = (status) =>
  (status?.candidates ?? 0) === 0
    ? "it has no Electron executable to inspect"
    : status.failures.length > 0
      ? "the inspection failed"
      : "no fuse wire found";

const fuseRegressions = (context) =>
  context.diff.runtimes.flatMap((pair) => {
    const after = pair.after?.fuses;
    if (!after || after.ambiguous) return [];
    const before = pair.before?.fuses ?? null;
    // Any old side that exists, an app directory with no executable among
    // them, has fuses REA did not establish rather than safe ones.
    const oldUnknown = context.left.target !== null;
    const unknowns = new Set();
    const rows = Object.entries(FUSES).flatMap(([name, fuse]) => {
      const now = after.fuses[name];
      if (!isRead(now) || now === fuse.safe) return [];
      const was =
        before && !before.ambiguous
          ? (before.fuses[name] ?? "unknown")
          : "unknown";
      if (was !== fuse.safe && was !== "unknown") return [];
      if (before === null && !oldUnknown) return [];
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
          ? `REA could not read ${context.labels.left}'s fuses (${oldFuseGap(context.left.runtimeStatus)}), so the old state is not established.`
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
