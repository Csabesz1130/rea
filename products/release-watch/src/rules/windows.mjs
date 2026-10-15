// RW-E02: BrowserWindow webPreferences regressions. REA reports each window's
// options but not which window of one release is which window of the other,
// so Release Watch pairs them: by the variable that holds a window and what
// it loads first, then identical windows (a reorder or a move to another file changes nothing),
// then the closest remaining ones by their other options, file and
// position. A new window with no counterpart is judged on its own values.
import { APP_SOURCE, cite, heuristic, reported } from "./shared.mjs";

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
const settingOf = (window, name) => window.data.web_preferences[name] ?? null;
const valueText = (setting) =>
  setting === null ? "omitted" : JSON.stringify([setting.known, setting.value]);
const signature = (window) =>
  JSON.stringify(
    Object.keys(window.data.web_preferences)
      .sort()
      .map((name) => [name, valueText(settingOf(window, name))]),
  );

const similarity = (a, b) => {
  const names = new Set([
    ...Object.keys(a.data.web_preferences),
    ...Object.keys(b.data.web_preferences),
  ]);
  return [...names].filter(
    (name) => valueText(settingOf(a, name)) === valueText(settingOf(b, name)),
  ).length;
};

const lineOf = (window) => window.location?.line ?? 0;

const loadsOf = (window) =>
  (window.data.loads ?? []).length > 0
    ? JSON.stringify(window.data.loads)
    : null;

// Pairs each new window with the one old window that shares its key; a key
// two old windows share pairs nothing.
const pairUnique = (state, keyOf) => {
  const remaining = [];
  for (const window of state.now) {
    const key = keyOf(window, "new");
    const matches =
      key === null ? [] : state.old.filter((was) => keyOf(was, "old") === key);
    if (matches.length !== 1) {
      remaining.push(window);
      continue;
    }
    state.old.splice(state.old.indexOf(matches[0]), 1);
    state.pairs.push([matches[0], window]);
  }
  state.now = remaining;
};

// Identity first: the variable a window is assigned to in its file, what it
// loads, then the variable alone, whatever its options.
const pairByIdentity = (oldWindows, newWindows, fileOf) => {
  const state = { old: [...oldWindows], now: [...newWindows], pairs: [] };
  const variable = (window) => window.data.variable ?? null;
  pairUnique(state, (window, side) =>
    variable(window) === null
      ? null
      : `${side === "old" ? fileOf(window) : windowFile(window)}\u0000${variable(window)}`,
  );
  pairUnique(state, loadsOf);
  pairUnique(state, variable);
  return state;
};

// The windows left once identical ones are paired off, the same file first.
const withoutIdentical = (oldWindows, newWindows, fileOf) => {
  const old = [...oldWindows];
  const now = [];
  const take = (window, sameFile) => {
    const index = old.findIndex(
      (candidate) =>
        signature(candidate) === signature(window) &&
        (fileOf(candidate) === windowFile(window)) === sameFile,
    );
    if (index !== -1) old.splice(index, 1);
    return index !== -1;
  };
  const unmatched = newWindows.filter((window) => !take(window, true));
  for (const window of unmatched) if (!take(window, false)) now.push(window);
  return { old, now };
};

/**
 * `{ pairs, added, tied }`: changed windows paired with their closest old
 * window, new windows with none, and whether any pairing had an equally
 * close alternative.
 */
const pairWindows = (oldWindows, newWindows, fileOf) => {
  const byIdentity = pairByIdentity(oldWindows, newWindows, fileOf);
  const { old, now } = withoutIdentical(byIdentity.old, byIdentity.now, fileOf);
  const score = (was, window) => [
    similarity(was, window),
    fileOf(was) === windowFile(window) ? 1 : 0,
    -Math.abs(lineOf(was) - lineOf(window)),
  ];
  const candidates = now
    .flatMap((window) =>
      old.map((was) => ({ was, window, score: score(was, window) })),
    )
    .sort((a, b) =>
      b.score.reduce(
        (order, value, index) => order || value - a.score[index],
        0,
      ),
    );
  const pairs = [...byIdentity.pairs];
  let tied = false;
  const usedOld = new Set();
  const usedNew = new Set();
  for (const candidate of candidates) {
    if (usedOld.has(candidate.was) || usedNew.has(candidate.window)) continue;
    tied ||= candidates.some(
      (other) =>
        other !== candidate &&
        !usedOld.has(other.was) &&
        !usedNew.has(other.window) &&
        (other.was === candidate.was || other.window === candidate.window) &&
        JSON.stringify(other.score) === JSON.stringify(candidate.score),
    );
    usedOld.add(candidate.was);
    usedNew.add(candidate.window);
    pairs.push([candidate.was, candidate.window]);
  }
  return { pairs, added: now.filter((window) => !usedNew.has(window)), tied };
};

// Windows whose setting of one preference regressed, by new file.
const regressionsOf = (paired, name, rule) => {
  const files = new Map();
  const state = (window) =>
    window === null ? null : stateOf(settingOf(window, name), rule);
  const items = [
    ...paired.pairs,
    ...paired.added.map((window) => [null, window]),
  ];
  for (const [was, now] of items) {
    const before = state(was);
    const after = state(now);
    const kind =
      after === "unsafe" && before !== "unsafe"
        ? "unsafe"
        : after === "dynamic" && before !== "dynamic" && before !== "unsafe"
          ? "dynamic"
          : null;
    if (kind === null) continue;
    const file = windowFile(now);
    if (!files.has(file)) files.set(file, { unsafe: [], dynamic: [] });
    files.get(file)[kind].push({ was, now });
  }
  return files;
};

// How the old release set the preference in the windows a regression pairs
// with: explicit values are REA facts, omitted values Electron's default.
const beforeLines = (context, name, rule, items) =>
  items.map(({ was, now }) => {
    if (was === null)
      return reported(
        `${context.labels.left}: no BrowserWindow corresponds to the one in ${windowFile(now)}`,
        "derived",
        APP_SOURCE,
      );
    const setting = settingOf(was, name);
    return setting === null
      ? heuristic(
          `${context.labels.left}: BrowserWindow in ${windowFile(was)} omits ${name}; Electron 20+ defaults it to ${JSON.stringify(rule.safe)}`,
          was.location,
          { side: "left" },
        )
      : cite(
          `${context.labels.left}: BrowserWindow in ${windowFile(was)}: ${settingText(name, setting)}`,
          was,
          APP_SOURCE,
          { side: "left" },
        );
  });

const regressionFinding = (
  context,
  { name, rule, file, items, known, tied },
) => {
  const oldDynamic =
    known &&
    items.some(
      ({ was }) =>
        was !== null && stateOf(settingOf(was, name), rule) === "dynamic",
    );
  const shown = settingOf(items[0].now, name);
  const verb = rule.safe === true ? "turned off" : "turned on";
  const omitted = items.some(
    ({ was }) => was !== null && settingOf(was, name) === null,
  );
  return {
    rule: "RW-E02",
    severity: known && !oldDynamic ? "high" : "medium",
    title: known
      ? `${rule.label} ${verb} (${name}: ${JSON.stringify(shown.value)})`
      : `${rule.label} no longer statically known (${name})`,
    summary: `${items.length} BrowserWindow${items.length === 1 ? "" : "s"} in ${file} set ${name} to ${known ? "the unsafe value" : "a dynamic value"} in ${context.labels.right}, where the corresponding ${items.length === 1 ? "window" : "windows"} of ${context.labels.left} did not.`,
    why: "This removes a layer that contains compromised or untrusted web content.",
    recommendation:
      "Ask the vendor to restore the setting or document the compensating control.",
    evidence: [
      ...beforeLines(context, name, rule, items),
      ...items.map(({ now }) =>
        cite(
          `${context.labels.right}: BrowserWindow in ${file}: ${settingText(name, settingOf(now, name))}`,
          now,
          APP_SOURCE,
        ),
      ),
      heuristic(
        "Release Watch pairs windows across releases by the variable that holds them, what they load, their options, file and position; REA does not identify a window across releases",
      ),
    ],
    unknowns: [
      "Static webPreferences do not prove runtime enforcement; code can still change them before window creation.",
      ...(oldDynamic
        ? [
            `${context.labels.left} set ${name} to a dynamic value REA did not resolve, so the old state is not established.`,
          ]
        : []),
      ...(tied
        ? [
            "Several old windows matched equally well, so the pairing may not be the vendor's own.",
          ]
        : []),
      ...(omitted
        ? [
            "Release Watch assumes Electron 20 or later defaults for omitted options; REA did not report the Electron version.",
          ]
        : []),
    ],
  };
};

/**
 * RW-E02 findings for one component. A component new in this release is
 * paired with every window of the old release.
 */
export const webPreferenceRegressions = (context) => {
  const { left, right } = context;
  if (!right.app) return [];
  const oldWindows =
    left.target === null
      ? (context.baseline.windows ?? [])
      : (left.app?.windows ?? null);
  // An old side REA could not analyze is coverage, not an empty release.
  if (oldWindows === null) return [];
  const aliases = context.aliases ?? new Map();
  const fileOf = (window) =>
    aliases.get(windowFile(window))?.path ?? windowFile(window);
  const paired = pairWindows(oldWindows, right.app.windows, fileOf);
  return Object.entries(WEB_PREFERENCES).flatMap(([name, rule]) =>
    [...regressionsOf(paired, name, rule)].map(([file, kinds]) => {
      const known = kinds.unsafe.length > 0;
      return regressionFinding(context, {
        name,
        rule,
        file,
        items: known ? kinds.unsafe : kinds.dynamic,
        known,
        tied: paired.tied,
      });
    }),
  );
};
