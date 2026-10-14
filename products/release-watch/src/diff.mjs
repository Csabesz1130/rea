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

const emptyApp = {
  coverage: { graph: "unavailable", semantic: "unavailable" },
  assets: [],
  ipcHandlers: [],
  bridgeMembers: [],
  windows: [],
  requests: [],
  childProcesses: [],
  timers: [],
  urlLiterals: [],
  bindingReads: [],
};

/** Compare the application facts of two releases, family by family. */
export const diffApplications = (leftApp, rightApp) => {
  const left = leftApp ?? emptyApp;
  const right = rightApp ?? emptyApp;
  const graph = {
    leftComplete: left.coverage.graph === "complete",
    rightComplete: right.coverage.graph === "complete",
  };
  const semantic = {
    leftComplete: left.coverage.semantic === "complete",
    rightComplete: right.coverage.semantic === "complete",
  };
  return {
    assets: diffKeyed(left.assets, right.assets, {
      ...graph,
      equal: sameDigest,
    }),
    ipcHandlers: diffKeyed(left.ipcHandlers, right.ipcHandlers, graph),
    bridgeMembers: diffKeyed(left.bridgeMembers, right.bridgeMembers, {
      ...graph,
      equal: sameJson,
    }),
    windows: diffKeyed(left.windows, right.windows, {
      ...graph,
      equal: sameJson,
      unique: true,
    }),
    requests: diffKeyed(left.requests, right.requests, semantic),
    childProcesses: diffKeyed(
      left.childProcesses,
      right.childProcesses,
      semantic,
    ),
    timers: diffKeyed(left.timers, right.timers, semantic),
    urlLiterals: diffKeyed(left.urlLiterals, right.urlLiterals, semantic),
  };
};

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
