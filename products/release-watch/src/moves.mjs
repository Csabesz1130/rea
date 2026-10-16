// Sites a release gained and lost in one fact family, paired one to one
// across its components: a gained site that takes a lost site of the same
// method and value is a move, not new behaviour. Each lost site explains at
// most one gained site, and a component whose new side REA could not analyze
// loses nothing: its old sites are unknown now, not gone.

// The facts of `from` that `against` has no counterpart for, by `field`.
const unmatched = (from, against, field) => {
  const remaining = against.map((fact) => fact.data[field] ?? null);
  return from.filter((fact) => {
    const index = remaining.indexOf(fact.data[field] ?? null);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
};

const pairable = (gained, lost, { field, unresolvedPairs }) => {
  if (gained.fact.data.method !== lost.fact.data.method) return false;
  const value = gained.fact.data[field] ?? null;
  if (value === null) return unresolvedPairs && lost.fact.data[field] == null;
  return value === lost.fact.data[field];
};

/**
 * `{ gained, pairs, lost }` for one family: the node ids of every gained
 * site, a Map from each gained site paired with a lost one to
 * `{ component, fact }`, and every lost site. `components` is
 * `[{ name, items, comparable, digests, keep }]`, with `items` the keyed diff
 * of the family, `digests` `{ left, right }` maps of module to SHA-256 and
 * `keep` optional `{ left, right }` tests that select the facts of each side
 * that take part (requests without a known destination). `unresolvedPairs`
 * lets two sites with no value pair (such requests), which process sites
 * never do. `sameFile` says when two sites must sit in the same file
 * content to pair: "never", "across" components (sites with nothing else
 * that ties a site of one component to a site of another), or "always"
 * (sites whose meaning depends on the code around them).
 */
export const releaseMoves = (
  components,
  { field, unresolvedPairs = false, sameFile = "never" },
) => {
  const gained = [];
  const lost = [];
  const all = () => true;
  for (const { name, items, comparable, digests, keep } of components)
    for (const item of items) {
      const right = item.right.filter(keep?.right ?? all);
      const left = item.left.filter(keep?.left ?? all);
      gained.push(
        ...unmatched(right, left, field).map((fact) => ({
          component: name,
          fact,
          digest: digests?.right.get(fact.data.module) ?? null,
        })),
      );
      if (comparable)
        lost.push(
          ...unmatched(left, right, field).map((fact) => ({
            component: name,
            fact,
            digest: digests?.left.get(fact.data.module) ?? null,
          })),
        );
    }
  const sameDigest = (site, candidate) =>
    site.digest !== null && site.digest === candidate.digest;
  const fileBound = (site, candidate, sameComponent) =>
    sameFile === "never" ||
    (sameFile === "across" && sameComponent) ||
    sameDigest(site, candidate);
  // A site whose file moved unchanged pairs with its old copy first, in
  // whichever component that is; of the rest, a move within a component is
  // the likelier explanation, so it pairs before one across components.
  const passes = [
    sameDigest,
    (site, candidate) =>
      candidate.component === site.component &&
      fileBound(site, candidate, true),
    (site, candidate) =>
      candidate.component !== site.component &&
      fileBound(site, candidate, false),
  ];
  const pairs = new Map();
  const used = new Set();
  for (const fits of passes)
    for (const site of gained) {
      if (pairs.has(site.fact.node_id)) continue;
      const match = lost.find(
        (candidate) =>
          !used.has(candidate) &&
          fits(site, candidate) &&
          pairable(site, candidate, { field, unresolvedPairs }),
      );
      if (!match) continue;
      used.add(match);
      pairs.set(site.fact.node_id, match);
    }
  return {
    gained: new Set(gained.map((site) => site.fact.node_id)),
    pairs,
    lost,
  };
};

/** The SHA-256 REA reported for each file of one app, by module path. */
export const fileDigests = (app) =>
  new Map(
    (app?.assets ?? [])
      .filter((asset) => asset.data.sha256)
      .map((asset) => [asset.key, asset.data.sha256]),
  );

/**
 * A test for files of one new side whose content the old release shipped
 * in any component (`baseline.digests`): code that moved, or stayed,
 * unchanged keeps what it had. A file REA reported no digest for is not.
 */
export const shippedBefore = (baseline, app) => {
  const digests = fileDigests(app);
  const shipped = baseline?.digests ?? new Set();
  return (module) => digests.has(module) && shipped.has(digests.get(module));
};

/** The facts of a group the release gained that no lost site accounts for. */
export const unaccounted = (moves, facts) =>
  facts.filter(
    (fact) => moves.gained.has(fact.node_id) && !moves.pairs.has(fact.node_id),
  );

/** The paired lost sites of a group's gained facts, or null when any gained fact is unpaired. */
export const movedFrom = (moves, facts) => {
  const gained = facts.filter((fact) => moves.gained.has(fact.node_id));
  if (gained.length === 0) return null;
  const sources = gained.map((fact) => moves.pairs.get(fact.node_id));
  return sources.every(Boolean) ? sources : null;
};
