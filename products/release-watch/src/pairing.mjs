// Pairs the parts of two releases: components, helper executables and
// Electron runtimes, by name first and then by kind and content.
import { contentSignature } from "./discover.mjs";
import { diffFuses, diffGo } from "./diff.mjs";

// Shared files over all files, 0 when either side has none.
const overlap = (a, b) => {
  const shared = [...a].filter((file) => b.has(file)).length;
  const total = new Set([...a, ...b]).size;
  return total === 0 ? 0 : shared / total;
};

const MIN_OVERLAP = 0.3;

/**
 * Pairs items by key, then the rest by `fallback` (a component's kind): an
 * item that is the only one of its kind on both sides pairs, and otherwise
 * the candidates of its kind whose `similarity` is highest, when at least
 * MIN_OVERLAP. Unpaired items pair with null.
 */
const pairBy = (before, after, { key, fallback, similarity }) => {
  const pairs = [];
  const unmatchedAfter = new Set(after);
  const unmatchedBefore = [];
  for (const item of before) {
    const match = after.find(
      (candidate) =>
        unmatchedAfter.has(candidate) && key(candidate) === key(item),
    );
    if (match) {
      unmatchedAfter.delete(match);
      pairs.push([item, match]);
    } else unmatchedBefore.push(item);
  }
  const sameKind = (item) =>
    [...unmatchedAfter].filter(
      (candidate) =>
        fallback(item) !== null && fallback(candidate) === fallback(item),
    );
  const scored = unmatchedBefore
    .flatMap((item) =>
      sameKind(item).map((candidate) => ({
        item,
        candidate,
        score: similarity(item, candidate),
      })),
    )
    .sort((a, b) => b.score - a.score);
  const paired = new Set();
  for (const { item, candidate, score } of scored) {
    if (paired.has(item) || !unmatchedAfter.has(candidate)) continue;
    const alone =
      unmatchedBefore.filter((other) => fallback(other) === fallback(item))
        .length === 1 && sameKind(item).length === 1;
    if (!alone && score < MIN_OVERLAP) continue;
    unmatchedAfter.delete(candidate);
    paired.add(item);
    pairs.push([item, candidate]);
  }
  for (const item of unmatchedBefore)
    if (!paired.has(item)) pairs.push([item, null]);
  return [...pairs, ...[...unmatchedAfter].map((item) => [null, item])];
};

// Helpers pair by relative path, then by file name when it is unique, so a
// helper that moved directory is compared with its old build.
export const pairHelpers = (left, right) =>
  pairBy(left.helpers, right.helpers, {
    key: (helper) => helper.relative,
    fallback: (helper) => helper.name,
    similarity: () => 0,
  })
    .map(([before, after]) => ({
      relative: (after ?? before).relative,
      name: (after ?? before).name,
      before,
      after,
      go: before?.go && after?.go ? diffGo(before.go, after.go) : null,
    }))
    .sort((a, b) => a.relative.localeCompare(b.relative));

// Executables pair by name. A new executable is compared with the old
// release's first one, so an unhardened executable added next to a hardened
// one is still graded.
export const pairRuntimes = (left, right) =>
  pairBy(left.runtimes, right.runtimes, {
    key: (runtime) => runtime.name,
    fallback: () => null,
    similarity: () => 0,
  }).map(([before, after]) => {
    const baseline = before ?? (after ? (left.runtimes[0] ?? null) : null);
    return {
      name: (after ?? before).name,
      before: baseline,
      after,
      matched: before !== null && after !== null,
      changes:
        baseline?.fuses && after?.fuses
          ? diffFuses(baseline.fuses, after.fuses)
          : [],
    };
  });

/**
 * Components pair by manifest name. A component left unpaired on each side
 * with the same kind of target is taken as renamed when it is the only such
 * pair, so its captures are still compared.
 */
export const pairComponents = (leftRelease, rightRelease) =>
  pairBy(leftRelease.components, rightRelease.components, {
    key: (component) => component.name,
    fallback: (component) => component.target.kind,
    similarity: (a, b) => overlap(contentSignature(a), contentSignature(b)),
  })
    // In the new release's manifest order, removed components last.
    .sort(
      ([, a], [, b]) =>
        (a === null ? Infinity : rightRelease.components.indexOf(a)) -
        (b === null ? Infinity : rightRelease.components.indexOf(b)),
    )
    .map(([before, after]) => ({
      name:
        before && after && before.name !== after.name
          ? `${before.name}-to-${after.name}`
          : (after ?? before).name,
      renamed:
        before && after && before.name !== after.name
          ? { from: before.name, to: after.name }
          : null,
      leftTarget: before?.target ?? null,
      rightTarget: after?.target ?? null,
    }));
