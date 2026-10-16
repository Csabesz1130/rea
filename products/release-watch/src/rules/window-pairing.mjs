// Which BrowserWindow of the old release each new window is. REA reports
// windows without an identity across releases, so Release Watch pairs them,
// release-wide and one old window to at most one new one:
// 1. by identity, each key unique on both sides: what the window loads, in
//    its file, then in any file; the named functions that create it and what
//    holds it, in its file, then in any file; what holds it. What a window
//    loads outranks the names of its functions, which a minifier renames
//    from build to build. First within each component, then across
//    components, so a window that moved to another component keeps its
//    counterpart;
// 2. within each component, identical options (a reorder or a move to
//    another file changes nothing), then the closest remaining window by its
//    other options, file and position;
// 3. for a component new in this release, the same with the old windows no
//    other component kept. A window in an existing component never pairs by
//    options alone with another component's window.
// A new window left without a counterpart is judged on its own values.

export const windowFile = (window) => window.data.source_path ?? window.key;

const byName = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
// A preference as it compares: its value, or the compared form of what REA
// did not resolve.
const comparable = (setting) =>
  setting === undefined
    ? null
    : setting.known
      ? [true, setting.value]
      : [false, setting.compared];
const optionsOf = (window) =>
  Object.entries(window.data.web_preferences)
    .map(([name, setting]) => [name, comparable(setting)])
    .sort(byName);
const signature = (window) =>
  JSON.stringify([
    optionsOf(window),
    (window.data.unresolved_preferences ?? []).map(({ source, compared }) => [
      source,
      compared,
    ]),
  ]);

const similarity = (a, b) => {
  const names = new Set([
    ...Object.keys(a.data.web_preferences),
    ...Object.keys(b.data.web_preferences),
  ]);
  return [...names].filter(
    (name) =>
      JSON.stringify(comparable(a.data.web_preferences[name])) ===
      JSON.stringify(comparable(b.data.web_preferences[name])),
  ).length;
};

const loadsOf = (window) =>
  (window.data.loads ?? []).length > 0
    ? JSON.stringify(window.data.loads)
    : null;
const holderOf = (window) => window.data.holder ?? null;
const scopeOf = (window) => window.data.scope ?? "";

// Identity keys, strongest first; null when the window has none.
const IDENTITY = [
  (window, file) =>
    loadsOf(window) === null ? null : `${file}\u0000${loadsOf(window)}`,
  (window) => loadsOf(window),
  (window, file) =>
    holderOf(window) === null && scopeOf(window) === ""
      ? null
      : `${file}\u0000${scopeOf(window)}\u0000${holderOf(window) ?? ""}`,
  (window) =>
    holderOf(window) === null || scopeOf(window) === ""
      ? null
      : `${scopeOf(window)}\u0000${holderOf(window)}`,
  (window) => holderOf(window),
];

// An old window's file as the new window it is compared with sees it: renamed
// modules map within one component only.
const fileFor = (was, now) =>
  was.component === now.component ? was.mapped : was.file;

const take = (state, was, now, tied) => {
  state.old.splice(state.old.indexOf(was), 1);
  state.now.splice(state.now.indexOf(now), 1);
  state.pairs.push({ was, now, tied });
};

// Pairs windows whose key one old and one new window share, within each
// component or release-wide.
const pairUnique = (state, keyOf, within) => {
  const groups = new Map();
  const add = (entry, side, file) => {
    const key = keyOf(entry.window, file);
    if (key === null) return;
    const group = `${within ? entry.component : ""}\u0000${key}`;
    if (!groups.has(group)) groups.set(group, { old: [], now: [] });
    groups.get(group)[side].push(entry);
  };
  for (const entry of state.old)
    add(entry, "old", within ? entry.mapped : entry.file);
  for (const entry of state.now) add(entry, "now", entry.file);
  for (const { old, now } of groups.values())
    if (old.length === 1 && now.length === 1) take(state, old[0], now[0]);
};

// Old windows a new window may pair with by options: its own component's,
// or, for a component new in this release, those no other component kept.
const OPTION_PHASES = [
  (was, now) => was.component === now.component,
  (_was, now) => now.newComponent,
];
const candidatesFor = (state, now, allowed) =>
  state.old.filter((was) => allowed(was, now));

// Identical options, the same file first.
const pairIdentical = (state, allowed) => {
  for (const sameFile of [true, false])
    // A copy: pairing takes windows out of state.now.
    for (const now of state.now.slice()) {
      const was = candidatesFor(state, now, allowed).find(
        (candidate) =>
          signature(candidate.window) === signature(now.window) &&
          (fileFor(candidate, now) === now.file) === sameFile,
      );
      if (was) take(state, was, now, false);
    }
};

const lineOf = (window) => window.location?.line ?? 0;
const sameScore = (a, b) => JSON.stringify(a.score) === JSON.stringify(b.score);

// The closest remaining windows, noting whether a pairing had an equally
// close alternative.
const pairClosest = (state, allowed) => {
  const candidates = state.now
    .flatMap((now) =>
      candidatesFor(state, now, allowed).map((was) => ({
        was,
        now,
        score: [
          similarity(was.window, now.window),
          fileFor(was, now) === now.file ? 1 : 0,
          -Math.abs(lineOf(was.window) - lineOf(now.window)),
        ],
      })),
    )
    .sort((a, b) =>
      b.score.reduce(
        (order, value, index) => order || value - a.score[index],
        0,
      ),
    );
  const used = new Set();
  for (const candidate of candidates) {
    if (used.has(candidate.was) || used.has(candidate.now)) continue;
    const tied = candidates.some(
      (other) =>
        other !== candidate &&
        !used.has(other.was) &&
        !used.has(other.now) &&
        (other.was === candidate.was || other.now === candidate.now) &&
        sameScore(other, candidate),
    );
    used.add(candidate.was);
    used.add(candidate.now);
    take(state, candidate.was, candidate.now, tied);
  }
};

const entriesOf = (components) => {
  const old = [];
  const now = [];
  for (const component of components) {
    const aliases = component.aliases ?? new Map();
    for (const window of component.old)
      old.push({
        window,
        component: component.name,
        file: windowFile(window),
        mapped: aliases.get(windowFile(window))?.path ?? windowFile(window),
      });
    for (const window of component.now)
      now.push({
        window,
        component: component.name,
        file: windowFile(window),
        index: now.length,
        newComponent: component.newComponent === true,
      });
  }
  return { old, now };
};

/**
 * Pairs every new window of a release with at most one old window. Takes
 * `[{ name, old, now, aliases, newComponent }]`, one entry per component
 * with the old windows it offers, the new windows to pair and whether the
 * component is new in this release, and returns, per component
 * name, `{ pairs: [{ was, now, tied, from }], added }`: each paired window
 * with its old counterpart, whether an equally close one existed and the
 * component it came from, and the new windows with no counterpart.
 */
export const pairReleaseWindows = (components) => {
  const state = { ...entriesOf(components), pairs: [] };
  for (const within of [true, false])
    for (const keyOf of IDENTITY) pairUnique(state, keyOf, within);
  for (const allowed of OPTION_PHASES) {
    pairIdentical(state, allowed);
    pairClosest(state, allowed);
  }
  const result = new Map(
    components.map((component) => [component.name, { pairs: [], added: [] }]),
  );
  for (const { was, now, tied } of [...state.pairs].sort(
    (a, b) => a.now.index - b.now.index,
  ))
    result.get(now.component).pairs.push({
      was: was.window,
      now: now.window,
      tied: tied === true,
      from: was.component,
    });
  for (const now of state.now) result.get(now.component).added.push(now.window);
  return result;
};

/**
 * The window pairing of a release from its prepared components (`{ name,
 * left, right, aliases }`). A component whose new side REA could not analyze
 * offers no old windows (they are unknown now, not gone); one whose old side
 * REA could not analyze is graded on coverage only, so its new windows take
 * none.
 */
export const releaseWindowPairing = (components) =>
  pairReleaseWindows(
    components.map(({ name, left, right, aliases }) => ({
      name,
      old: right.target === null || right.app ? (left.app?.windows ?? []) : [],
      now:
        right.app && (left.target === null || left.app)
          ? right.app.windows
          : [],
      aliases,
      newComponent: left.target === null,
    })),
  );
