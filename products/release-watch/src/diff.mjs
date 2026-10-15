// Keyed comparison of capability facts across two releases. Absence counts as
// "added"/"removed" only when the other side's REA coverage is complete;
// otherwise the item stays "not-previously-observed"/"no-longer-observed".

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
 * "ambiguous" when `unique` is set.
 */
export const diffKeyed = (left, right, options) => {
  const {
    leftComplete,
    rightComplete,
    equal = () => true,
    unique = false,
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
  item.status === "added" || item.status === "not-previously-observed";

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
  { family: "requests", coverage: "semantic", moduleKeyed: true },
  { family: "childProcesses", coverage: "semantic", moduleKeyed: true },
  { family: "timers", coverage: "semantic", moduleKeyed: true },
  { family: "configReads", coverage: "semantic" },
  {
    family: "stringLiterals",
    coverage: "semantic",
    moduleKeyed: true,
    equal: sameValues("value"),
  },
  { family: "urlLiterals", coverage: "semantic" },
  { family: "htmlSinks", coverage: "semantic", moduleKeyed: true },
  {
    family: "memberCalls",
    coverage: "semantic",
    moduleKeyed: true,
    equal: (a, b) => a.length === b.length,
  },
  { family: "dynamicEvaluation", coverage: "semantic", moduleKeyed: true },
];

const EMPTY_APP = {
  coverage: { graph: "unavailable", semantic: "unavailable" },
  ...Object.fromEntries(FAMILIES.map(({ family }) => [family, []])),
};

// Content-hashed bundle names: Vite/Rollup `name-Hash.js`, webpack
// `name.hash.js`. A hash segment has a digit or an uppercase letter, so a
// plain word such as `-generator` is never taken for one.
const HASHED_NAME = [
  /-(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{8,}(?=\.(m?js|css)$)/,
  /\.(?=[a-f0-9]*[0-9])[a-f0-9]{8,}(?=(\.chunk)?\.(m?js|css)$)/,
];
const withoutHash = (modulePath) =>
  HASHED_NAME.reduce((name, pattern) => name.replace(pattern, ""), modulePath);

const scriptPaths = (app) =>
  app.assets
    .map((asset) => asset.key)
    .filter((key) => /\.(m?js|cjs|ts|mts)$/.test(key));

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
  for (const [bare, leftPath] of leftNames) {
    const rightPath = rightNames.get(bare);
    if (!leftPath || !rightPath || leftPath === rightPath) continue;
    if (aliases.has(leftPath) || rightPaths.has(leftPath)) continue;
    aliases.set(leftPath, {
      path: rightPath,
      basis: "same bundle name without content hash",
    });
  }
  return aliases;
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

/** Compare the application facts of two releases, family by family. */
export const diffApplications = (leftApp, rightApp, aliases = new Map()) => {
  const left = leftApp ?? EMPTY_APP;
  const right = rightApp ?? EMPTY_APP;
  const complete = (app, coverage) => app.coverage[coverage] === "complete";
  return Object.fromEntries(
    FAMILIES.map(({ family, coverage, moduleKeyed, equal, unique }) => [
      family,
      diffKeyed(
        moduleKeyed ? rekey(left[family], aliases) : left[family],
        right[family],
        {
          leftComplete: complete(left, coverage),
          rightComplete: complete(right, coverage),
          equal,
          unique,
        },
      ),
    ]),
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

/** Compare two runtime captures, or return null unless both sides have one. */
export const diffCaptures = (left, right) =>
  left === null || right === null
    ? null
    : Object.fromEntries(
        CAPTURE_FAMILIES.map(({ family, equal }) => [
          family,
          diffKeyed(left[family], right[family], {
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
