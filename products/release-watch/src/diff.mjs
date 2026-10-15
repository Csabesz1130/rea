// Keyed comparison of capability facts across two releases. Absence counts as
// "added"/"removed" only when the other side's REA coverage is complete;
// otherwise the item stays "not-previously-observed"/"no-longer-observed".
import { isScriptPath, withoutHash } from "./facts/modules.mjs";

const groupByKey = (facts) => {
  const groups = new Map();
  for (const fact of facts) {
    if (!groups.has(fact.key)) groups.set(fact.key, []);
    groups.get(fact.key).push(fact);
  }
  return groups;
};

/**
 * Compare two fact lists by key. `equal(left, right)` decides whether a key
 * present on both sides changed; keys with several facts on either side are
 * "ambiguous" when `unique` is set. For `countable` families, a key with more
 * facts on the right than on the left is "increased": a site was added where
 * one already existed.
 */
export const diffKeyed = (left, right, options) => {
  const {
    leftComplete,
    rightComplete,
    equal = () => true,
    unique = false,
    countable = false,
  } = options;
  const leftGroups = groupByKey(left);
  const rightGroups = groupByKey(right);
  const keys = [
    ...new Set([...leftGroups.keys(), ...rightGroups.keys()]),
  ].sort();
  return keys.map((key) => {
    const before = leftGroups.get(key) ?? [];
    const after = rightGroups.get(key) ?? [];
    let status;
    if (unique && (before.length > 1 || after.length > 1)) status = "ambiguous";
    else if (countable && before.length > 0 && after.length > before.length)
      status = "increased";
    else if (before.length > 0 && after.length > 0)
      status = equal(before, after) ? "unchanged" : "changed";
    else if (after.length > 0)
      status = leftComplete ? "added" : "not-previously-observed";
    else status = rightComplete ? "removed" : "no-longer-observed";
    return { key, status, left: before, right: after };
  });
};

/** True for statuses that mean "present now, not present or not seen before". */
export const isNew = (item) =>
  item.status === "added" ||
  item.status === "not-previously-observed" ||
  item.status === "increased";

const sameDigest = (before, after) =>
  before[0].data.sha256 !== null &&
  before[0].data.sha256 === after[0].data.sha256;

const sameJson = (before, after) =>
  JSON.stringify(before.map((fact) => fact.data)) ===
  JSON.stringify(after.map((fact) => fact.data));

const sameValues = (field) => (before, after) => {
  const values = (facts) =>
    JSON.stringify(facts.map((fact) => fact.data[field]).sort());
  return values(before) === values(after);
};

// Every application fact family, its REA coverage source and how two sides
// compare. Module-keyed families are re-keyed through module aliases first.
const FAMILIES = [
  { family: "assets", coverage: "graph", equal: sameDigest },
  { family: "ipcHandlers", coverage: "graph" },
  { family: "bridgeMembers", coverage: "graph", equal: sameJson },
  { family: "windows", coverage: "graph", equal: sameJson, unique: true },
  { family: "packages", coverage: "graph", equal: sameValues("version") },
  { family: "imports", coverage: "graph" },
  { family: "endpoints", coverage: "graph" },
  { family: "pageScripts", coverage: "graph" },
  { family: "serviceWorkers", coverage: "graph" },
  { family: "embeddedSources", coverage: "graph" },
  { family: "storage", coverage: "graph" },
  {
    family: "requests",
    coverage: "semantic",
    moduleKeyed: true,
    countable: true,
  },
  {
    family: "childProcesses",
    coverage: "semantic",
    moduleKeyed: true,
    countable: true,
    // Same count with a different command is a change, not an unchanged key.
    equal: sameValues("command"),
  },
  { family: "timers", coverage: "semantic", moduleKeyed: true },
  { family: "configReads", coverage: "semantic" },
  {
    family: "stringLiterals",
    coverage: "semantic",
    moduleKeyed: true,
    equal: sameValues("value"),
  },
  { family: "urlLiterals", coverage: "semantic" },
  {
    family: "htmlSinks",
    coverage: "semantic",
    moduleKeyed: true,
    countable: true,
  },
  {
    family: "memberCalls",
    coverage: "semantic",
    moduleKeyed: true,
    countable: true,
  },
  {
    family: "dynamicEvaluation",
    coverage: "semantic",
    moduleKeyed: true,
    countable: true,
  },
];

const EMPTY_APP = {
  coverage: { graph: "unavailable", semantic: "unavailable" },
  ...Object.fromEntries(FAMILIES.map(({ family }) => [family, []])),
};

// Content-hashed bundle names: Vite/Rollup `name-Hash.js`, webpack
// `name.hash.js`. A hash segment has a digit or an uppercase letter, so a
// plain word such as `-generator` is never taken for one.

const scriptPaths = (app) =>
  app.assets.map((asset) => asset.key).filter(isScriptPath);

// Scripts an HTML page loads directly, as module paths.
const htmlLoaded = (app) =>
  new Set(
    (app.pageScripts ?? []).map((script) =>
      String(script.data.script_path)
        .trim()
        .replace(/^\.?\//, ""),
    ),
  );

/**
 * Map old module paths to new ones: REA's own pairing of changed assets
 * first, then bundles whose names match once their content hash is removed,
 * when that name is unique on both sides. Unpaired paths keep their name.
 */
export const moduleAliases = (leftApp, rightApp, reaPairs = []) => {
  const aliases = new Map();
  if (!leftApp || !rightApp) return aliases;
  for (const pair of reaPairs)
    if (pair.left !== pair.right)
      aliases.set(pair.left, { path: pair.right, basis: `REA ${pair.basis}` });
  const leftPaths = scriptPaths(leftApp);
  const rightPaths = new Set(scriptPaths(rightApp));
  const byBareName = (paths) => {
    const names = new Map();
    for (const modulePath of paths) {
      const bare = withoutHash(modulePath);
      names.set(bare, names.has(bare) ? null : modulePath);
    }
    return names;
  };
  const leftNames = byBareName(leftPaths);
  const rightNames = byBareName(rightPaths);
  const pair = (leftPath, rightPath, basis) => {
    if (!leftPath || !rightPath || leftPath === rightPath) return;
    if (aliases.has(leftPath) || rightPaths.has(leftPath)) return;
    aliases.set(leftPath, { path: rightPath, basis });
  };
  for (const [bare, leftPath] of leftNames)
    pair(
      leftPath,
      rightNames.get(bare),
      "same bundle name without content hash",
    );
  // Several bundles sharing a hash-free name (a Vite entry and a lazy chunk
  // both named index-*.js) pair by role: the one an HTML page loads, and the
  // one it does not, when each role has one bundle on each side.
  const leftHtml = htmlLoaded(leftApp);
  const rightHtml = htmlLoaded(rightApp);
  const unpaired = (paths, taken) =>
    paths.filter((modulePath) => !taken.has(modulePath));
  const pairedRight = new Set([...aliases.values()].map((alias) => alias.path));
  for (const [bare, leftPath] of leftNames) {
    if (leftPath !== null || rightNames.get(bare) !== null) continue;
    const before = unpaired(
      leftPaths.filter((path) => withoutHash(path) === bare),
      aliases,
    );
    const after = unpaired(
      [...rightPaths].filter((path) => withoutHash(path) === bare),
      pairedRight,
    );
    for (const loaded of [true, false]) {
      const left = before.filter((path) => leftHtml.has(path) === loaded);
      const right = after.filter((path) => rightHtml.has(path) === loaded);
      if (left.length === 1 && right.length === 1)
        pair(
          left[0],
          right[0],
          `same bundle name and role (${loaded ? "loaded by HTML" : "imported"}) without content hash`,
        );
    }
  }
  return aliases;
};

/**
 * New-side scripts Release Watch could not pair: their name without the
 * content hash is shared by several scripts on either side, and neither REA
 * nor a unique name paired them.
 */
export const ambiguousBundles = (leftApp, rightApp, aliases) => {
  if (!leftApp || !rightApp) return new Set();
  const count = (paths) =>
    paths.reduce((counts, modulePath) => {
      const bare = withoutHash(modulePath);
      return bare === modulePath
        ? counts
        : counts.set(bare, (counts.get(bare) ?? 0) + 1);
    }, new Map());
  const leftPaths = scriptPaths(leftApp);
  const before = count(leftPaths);
  const after = count(scriptPaths(rightApp));
  const paired = new Set([...aliases.values()].map((alias) => alias.path));
  const unchanged = new Set(leftPaths);
  return new Set(
    scriptPaths(rightApp).filter((modulePath) => {
      const bare = withoutHash(modulePath);
      if (
        bare === modulePath ||
        paired.has(modulePath) ||
        unchanged.has(modulePath)
      )
        return false;
      return (before.get(bare) ?? 0) > 1 || (after.get(bare) ?? 0) > 1;
    }),
  );
};

const rekey = (facts, aliases) =>
  aliases.size === 0
    ? facts
    : facts.map((fact) => {
        const modulePath = fact.data?.module;
        const alias =
          typeof modulePath === "string" ? aliases.get(modulePath) : undefined;
        if (alias === undefined || !fact.key.startsWith(`${modulePath}#`))
          return fact;
        return {
          ...fact,
          key: `${alias.path}${fact.key.slice(modulePath.length)}`,
        };
      });

// Bundle names several unpaired files share once their content hash is
// removed (two `index-<hash>.js` chunks): their facts are compared as one
// pool, so unchanged code in them is not new.
const pooledNames = (left, right, aliases) => {
  const paired = new Set([
    ...aliases.keys(),
    ...[...aliases.values()].map((alias) => alias.path),
  ]);
  const counts = new Map();
  for (const [side, app] of [
    ["left", left],
    ["right", right],
  ])
    for (const modulePath of scriptPaths(app)) {
      const bare = withoutHash(modulePath);
      if (bare === modulePath || paired.has(modulePath)) continue;
      const entry = counts.get(bare) ?? { left: 0, right: 0 };
      entry[side] += 1;
      counts.set(bare, entry);
    }
  return new Set(
    [...counts]
      .filter(([, entry]) => entry.left > 1 || entry.right > 1)
      .map(([bare]) => bare),
  );
};

const pool = (facts, pools) =>
  pools.size === 0
    ? facts
    : facts.map((fact) => {
        const modulePath = fact.data?.module;
        if (typeof modulePath !== "string") return fact;
        const bare = withoutHash(modulePath);
        if (!pools.has(bare) || !fact.key.startsWith(`${modulePath}#`))
          return fact;
        return { ...fact, key: `${bare}${fact.key.slice(modulePath.length)}` };
      });

/** Compare the application facts of two releases, family by family. */
export const diffApplications = (
  leftApp,
  rightApp,
  aliases = new Map(),
  { leftKnown = true } = {},
) => {
  const left = leftApp ?? EMPTY_APP;
  const right = rightApp ?? EMPTY_APP;
  const complete = (app, coverage) => app.coverage[coverage] === "complete";
  // An old side REA could not analyze is not an empty one: nothing is compared.
  if (!leftKnown)
    return Object.fromEntries(
      FAMILIES.map(({ family }) => [
        family,
        diffKeyed([], right[family], {}).map((item) => ({
          ...item,
          status: "not-compared",
        })),
      ]),
    );
  const pools =
    leftApp && rightApp ? pooledNames(left, right, aliases) : new Set();
  return Object.fromEntries(
    FAMILIES.map(
      ({ family, coverage, moduleKeyed, equal, unique, countable }) => [
        family,
        diffKeyed(
          moduleKeyed
            ? pool(rekey(left[family], aliases), pools)
            : left[family],
          moduleKeyed ? pool(right[family], pools) : right[family],
          {
            leftComplete: complete(left, coverage),
            rightComplete: complete(right, coverage),
            equal,
            unique,
            countable,
          },
        ),
      ],
    ),
  );
};

// Capture families: a capture records one session, so absence is never
// established and one-sided items stay "not observed".
const CAPTURE_FAMILIES = [
  { family: "exchanges" },
  { family: "documents" },
  { family: "cookies", equal: sameJson },
  { family: "credentials" },
  { family: "apiGroups" },
];

const EMPTY_CAPTURE = Object.fromEntries(
  CAPTURE_FAMILIES.map(({ family }) => [family, []]),
);

/**
 * Compare two runtime captures. Null without a new capture; without an old
 * one, every new fact is "not previously observed".
 */
export const diffCaptures = (left, right) =>
  right === null
    ? null
    : Object.fromEntries(
        CAPTURE_FAMILIES.map(({ family, equal }) => [
          family,
          diffKeyed((left ?? EMPTY_CAPTURE)[family], right[family], {
            leftComplete: false,
            rightComplete: false,
            equal,
          }),
        ]),
      );

/** Pair two fuse wires and list every fuse whose state differs. */
export const diffFuses = (left, right) => {
  if (left === null || right === null) return [];
  const names = [
    ...new Set([...Object.keys(left.fuses), ...Object.keys(right.fuses)]),
  ];
  return names
    .map((name) => ({
      name,
      before: left.fuses[name] ?? "unknown",
      after: right.fuses[name] ?? "unknown",
    }))
    .filter((change) => change.before !== change.after);
};

/** Compare Go build information of one helper across releases. */
export const diffGo = (left, right) => {
  const dependencies = diffKeyed(
    (left?.dependencies ?? []).map((dependency) => ({
      key: dependency.path,
      data: dependency,
    })),
    (right?.dependencies ?? []).map((dependency) => ({
      key: dependency.path,
      data: dependency,
    })),
    {
      leftComplete: left !== null,
      rightComplete: right !== null,
      equal: sameJson,
    },
  );
  const keys = new Set([
    ...Object.keys(left?.settings ?? {}),
    ...Object.keys(right?.settings ?? {}),
  ]);
  const settings = [...keys]
    .sort()
    .map((key) => ({
      key,
      before: left?.settings[key] ?? null,
      after: right?.settings[key] ?? null,
    }))
    .filter((setting) => setting.before !== setting.after);
  return {
    go_version:
      left?.go_version === right?.go_version
        ? null
        : {
            before: left?.go_version ?? null,
            after: right?.go_version ?? null,
          },
    dependencies,
    settings,
  };
};
