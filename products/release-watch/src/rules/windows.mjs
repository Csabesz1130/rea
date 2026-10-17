// RW-E02: BrowserWindow webPreferences regressions. REA reports each window's
// options but not which window of one release is which window of the other;
// window-pairing.mjs pairs them release-wide. A paired window regressed when
// a safeguard became unsafe, became a dynamic value or one REA did not
// resolve, or changed dynamic value (compared in the form the facts give
// it); a new window with no counterpart is judged on its own values.
import { componentName } from "./component-absence.mjs";
import { windowFile } from "./window-pairing.mjs";
import { APP_SOURCE, cite, heuristic } from "./shared.mjs";

// Values Electron uses when the option is omitted (Electron 20 and later),
// and how a change to the unsafe value reads.
const WEB_PREFERENCES = {
  sandbox: {
    safe: true,
    label: "Renderer sandbox",
    change: "turned off",
    state: "off",
    newWindow: "without the renderer sandbox",
  },
  contextIsolation: {
    safe: true,
    label: "Context isolation",
    change: "turned off",
    state: "off",
    newWindow: "without context isolation",
  },
  nodeIntegration: {
    safe: false,
    label: "Node.js integration in the renderer",
    change: "turned on",
    state: "on",
    newWindow: "with Node.js integration in the renderer",
  },
  nodeIntegrationInWorker: {
    safe: false,
    label: "Node.js integration in workers",
    change: "turned on",
    state: "on",
    newWindow: "with Node.js integration in workers",
  },
  webSecurity: {
    safe: true,
    label: "Web security (same-origin policy)",
    change: "turned off",
    state: "off",
    newWindow: "without web security (same-origin policy)",
  },
  allowRunningInsecureContent: {
    safe: false,
    label: "Mixed-content blocking",
    change: "turned off",
    state: "off",
    newWindow: "without mixed-content blocking",
  },
};

const unresolvedText = (unresolved) =>
  unresolved
    .map(({ source, expression }) =>
      source === "spread"
        ? `...${expression ?? "(spread)"}`
        : source === "computed key"
          ? `computed key ${expression ?? ""}`.trim()
          : `the ${source} value`,
    )
    .join(", ");

/**
 * One window's setting of one preference: what REA reported for it, else
 * the values REA did not resolve that may set it (`explicit: false`), else
 * null when the window omits it. A value REA did not resolve has `value`,
 * its text, and `compared`, the form it is compared in.
 */
const settingOf = (window, name) => {
  const explicit = window.data.web_preferences[name];
  if (explicit) return { ...explicit, explicit: true };
  const unresolved = window.data.unresolved_preferences ?? [];
  return unresolved.length === 0
    ? null
    : {
        known: false,
        value: unresolvedText(unresolved),
        compared: JSON.stringify(
          unresolved.map(({ source, compared }) => [source, compared]),
        ),
        explicit: false,
      };
};

// "default" when omitted, "dynamic" when not statically known.
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
    : setting.known
      ? `${name} = ${JSON.stringify(setting.value)}`
      : setting.explicit
        ? `${name} = dynamic value ${setting.value ?? ""}`.trim()
        : `${name} may be set by ${setting.value}, which REA did not resolve`;

// How one preference of one paired or new window regressed: "unsafe",
// "dynamic" (an explicit value REA did not resolve), "unresolved" (a value
// REA did not resolve that may set it), or null.
const changeOf = (name, rule, { was, now }) => {
  const after = settingOf(now, name);
  const before = was === null ? null : settingOf(was, name);
  const afterState = stateOf(after, rule);
  const beforeState = was === null ? null : stateOf(before, rule);
  if (afterState === "unsafe")
    return beforeState === "unsafe" ? null : "unsafe";
  if (afterState !== "dynamic" || beforeState === "unsafe") return null;
  // The same unresolved value on both sides is not a change Release Watch
  // can see; a different one is.
  if (beforeState === "dynamic" && before.compared === after.compared)
    return null;
  return after.explicit ? "dynamic" : "unresolved";
};

// Regressions grouped into findings: one per preference, file, kind,
// whether the windows are new and whether REA resolved their old value;
// values REA did not resolve, one per file.
const regressionGroups = (items) => {
  const groups = new Map();
  for (const [name, rule] of Object.entries(WEB_PREFERENCES))
    for (const item of items) {
      const kind = changeOf(name, rule, item);
      if (kind === null) continue;
      const file = windowFile(item.now);
      const added = item.was === null;
      const key = JSON.stringify([
        kind,
        kind === "unresolved" ? null : name,
        file,
        added,
        kind !== "unresolved" &&
          !added &&
          stateOf(settingOf(item.was, name), rule) === "dynamic",
      ]);
      if (!groups.has(key))
        groups.set(key, { kind, name, rule, file, added, items: new Map() });
      const group = groups.get(key);
      const entry = group.items.get(item.now) ?? { ...item, names: [] };
      entry.names.push(name);
      group.items.set(item.now, entry);
    }
  return [...groups.values()].map((group) => ({
    ...group,
    items: [...group.items.values()],
  }));
};

// The old states of the options a paired or new window reports on.
const oldStates = ({ was, names }) =>
  was === null
    ? []
    : names.map((name) => stateOf(settingOf(was, name), WEB_PREFERENCES[name]));

const counted = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const themOrIt = (items) => (items.length === 1 ? "it" : "them");

const defaultsText = (names) =>
  names.length === 1
    ? `defaults it to ${JSON.stringify(WEB_PREFERENCES[names[0]].safe)}`
    : `defaults ${names.map((name) => `${name} to ${JSON.stringify(WEB_PREFERENCES[name].safe)}`).join(", ")}`;

// How the old release set the preferences in the windows a regression pairs
// with: what REA reported, and omitted values as Electron's default.
const beforeLines = (context, items) =>
  items
    .filter(({ was }) => was !== null)
    .flatMap(({ was, from, names }) => {
      const where = `${context.labels.left}: BrowserWindow in ${windowFile(was)}${from && from !== context.id ? ` of component ${componentName(context, "left", from)}` : ""}`;
      const settings = names.map((name) => [name, settingOf(was, name)]);
      const omitted = settings
        .filter(([, setting]) => setting === null)
        .map(([name]) => name);
      const set = settings.filter(([, setting]) => setting !== null);
      return [
        ...(set.length > 0
          ? [
              cite(
                `${where}: ${set.map(([name, setting]) => settingText(name, setting)).join("; ")}`,
                was,
                APP_SOURCE,
                { side: "left" },
              ),
            ]
          : []),
        ...(omitted.length > 0
          ? [
              heuristic(
                `${where} omits ${omitted.join(", ")}; Electron 20+ ${defaultsText(omitted)}`,
                was.location,
                { side: "left" },
              ),
            ]
          : []),
      ];
    });

const afterLines = (context, group) =>
  group.items.map(({ now, names }) =>
    cite(
      group.kind === "unresolved"
        ? `${context.labels.right}: BrowserWindow in ${group.file}: ${names.join(", ")} may be set by ${settingOf(now, names[0]).value}, which REA did not resolve`
        : `${context.labels.right}: BrowserWindow in ${group.file}: ${settingText(group.name, settingOf(now, group.name))}`,
      now,
      APP_SOURCE,
    ),
  );

const pairingLine = (context, group) =>
  group.added
    ? heuristic(
        `Release Watch paired no ${context.labels.left} BrowserWindow with ${group.items.length === 1 ? "this one" : "these"}: it pairs windows by what they load, the functions that create them, what holds them and their options, as REA does not identify a window across releases`,
      )
    : heuristic(
        "Release Watch pairs windows across releases by what they load, the functions that create them, what holds them, their options, file and position; REA does not identify a window across releases",
      );

// What the evidence does not establish for one group.
const unknownsOf = (context, group, oldDynamic) => {
  const omitted = group.items.some(
    ({ was, names }) =>
      was !== null && names.some((name) => settingOf(was, name) === null),
  );
  const overridable =
    group.kind !== "unresolved" &&
    group.items.some(({ was, now }) =>
      [was, now].some(
        (window) =>
          window !== null &&
          settingOf(window, group.name)?.explicit === true &&
          (window.data.unresolved_preferences ?? []).length > 0,
      ),
    );
  return [
    "Static webPreferences do not prove runtime enforcement; code can still change them before window creation.",
    ...(oldDynamic
      ? [
          `${context.labels.left} took ${group.kind === "unresolved" ? "these options" : group.name} from a value REA did not resolve, so the old state is not established.`,
        ]
      : []),
    ...(overridable
      ? [
          `REA reports ${group.name} next to values it did not resolve (a spread or computed key) but not their order, so one of them may override it.`,
        ]
      : []),
    ...(group.items.some((item) => item.tied)
      ? [
          "Several old windows matched equally well, so the pairing may not be the vendor's own.",
        ]
      : []),
    ...(omitted
      ? [
          "Release Watch assumes Electron 20 or later defaults for omitted options; REA did not report the Electron version.",
        ]
      : []),
  ];
};

const unsafeText = (context, group, oldDynamic) => {
  const { name, rule, items, added, file } = group;
  const shown = JSON.stringify(settingOf(items[0].now, name).value);
  const paired = `the ${context.labels.left} ${items.length === 1 ? "window" : "windows"} Release Watch paired with ${themOrIt(items)}`;
  if (oldDynamic)
    return {
      title: `${rule.label} ${rule.state}, old value not established (${name}: ${shown})`,
      summary: `${counted(items.length, "BrowserWindow")} in ${file} set ${name} to the unsafe value in ${context.labels.right}, where ${paired} took it from a value REA did not resolve.`,
      why: "If the old window had this safeguard, this removes a layer that contains compromised or untrusted web content.",
      recommendation:
        "Ask the vendor what the old setting was, and to restore it or document the compensating control.",
    };
  return added
    ? {
        title: `New BrowserWindow ${rule.newWindow} (${name}: ${shown})`,
        summary: `${counted(items.length, "new BrowserWindow")} in ${file} set ${name} to the unsafe value in ${context.labels.right}; Release Watch paired no ${context.labels.left} window with ${themOrIt(items)}.`,
        why: "The window runs without a layer that contains compromised or untrusted web content.",
        recommendation:
          "Ask the vendor why the new window needs this setting, or to document the compensating control.",
      }
    : {
        title: `${rule.label} ${rule.change} (${name}: ${shown})`,
        summary: `${counted(items.length, "BrowserWindow")} in ${file} set ${name} to the unsafe value in ${context.labels.right}, where ${paired} did not.`,
        why: "This removes a layer that contains compromised or untrusted web content.",
        recommendation:
          "Ask the vendor to restore the setting or document the compensating control.",
      };
};

const dynamicText = (context, group) => {
  const { name, rule, items, added, file, kind } = group;
  const unresolved = kind === "unresolved";
  const names = Object.keys(WEB_PREFERENCES).filter((option) =>
    items.some((item) => item.names.includes(option)),
  );
  const what = unresolved
    ? `took ${names.join(", ")} from values REA did not resolve`
    : `set ${name} to a dynamic value REA did not resolve`;
  // Every paired window already had a value REA did not resolve, another one.
  const changed = items.every(
    (item) =>
      item.was !== null &&
      oldStates(item).every((state) => state === "dynamic"),
  );
  const paired = `the ${context.labels.left} ${items.length === 1 ? "window" : "windows"} Release Watch paired with ${themOrIt(items)}`;
  return {
    title: added
      ? `New BrowserWindow with ${unresolved ? "webPreferences" : name} not statically known`
      : unresolved
        ? `webPreferences ${changed ? "set from a different unresolved value" : "no longer statically known"}`
        : `${rule.label} ${changed ? "set to a different dynamic value" : "no longer statically known"} (${name})`,
    summary: added
      ? `${counted(items.length, "new BrowserWindow")} in ${file} ${what} in ${context.labels.right}; Release Watch paired no ${context.labels.left} window with ${themOrIt(items)}.`
      : `${counted(items.length, "BrowserWindow")} in ${file} ${what} in ${context.labels.right}, where ${paired} ${changed ? "used a different one" : "did not"}.`,
    why: "Release Watch cannot tell whether the window keeps the layers that contain compromised or untrusted web content.",
    recommendation:
      "Ask the vendor what the settings are at runtime, or to document the compensating control.",
  };
};

const regressionFinding = (context, group) => {
  const oldDynamic = group.items.some((item) =>
    oldStates(item).includes("dynamic"),
  );
  return {
    rule: "RW-E02",
    severity: group.kind === "unsafe" && !oldDynamic ? "high" : "medium",
    ...(group.kind === "unsafe"
      ? unsafeText(context, group, oldDynamic)
      : dynamicText(context, group)),
    evidence: [
      ...beforeLines(context, group.items),
      ...afterLines(context, group),
      pairingLine(context, group),
    ],
    unknowns: unknownsOf(context, group, oldDynamic),
  };
};

/**
 * RW-E02 findings for one component, from the release-wide window pairing,
 * which decides which sides' windows take part.
 */
export const webPreferenceRegressions = (context) => {
  if (!context.right.app) return [];
  const paired = context.windows.get(context.id);
  const items = [
    ...paired.pairs,
    ...paired.added.map((now) => ({ was: null, now, tied: false, from: null })),
  ];
  return regressionGroups(items).map((group) =>
    regressionFinding(context, group),
  );
};
