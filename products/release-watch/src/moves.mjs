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
 * `[{ name, items, comparable, digests }]`, with `items` the keyed diff of
 * the family and `digests` `{ left, right }` maps of module to SHA-256.
 * `keep` selects the facts that take part; `unresolvedPairs` lets two sites
 * with no value pair (requests with no resolved destination), which process
 * sites never do. `sameFile` says when two sites must sit in the same file
 * content to pair: "never", "across" components (sites with nothing else
 * that ties a site of one component to a site of another), or "always"
 * (sites whose meaning depends on the code around them).
 */
export const releaseMoves = (
  components,
  { field, keep = () => true, unresolvedPairs = false, sameFile = "never" },
) => {
  const gained = [];
  const lost = [];
  for (const { name, items, comparable, digests } of components)
    for (const item of items) {
      const right = item.right.filter(keep);
      const left = item.left.filter(keep);
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
  const fileBound = (site, candidate, sameComponent) =>
    sameFile === "never" ||
    (sameFile === "across" && sameComponent) ||
    (site.digest !== null && site.digest === candidate.digest);
  const pairs = new Map();
  const used = new Set();
  // A move within a component is the likelier explanation, so it pairs first.
  for (const sameComponent of [true, false])
    for (const site of gained) {
      if (pairs.has(site.fact.node_id)) continue;
      const match = lost.find(
        (candidate) =>
          !used.has(candidate) &&
          (candidate.component === site.component) === sameComponent &&
          fileBound(site, candidate, sameComponent) &&
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

/** The paired lost sites of a group's gained facts, or null when any gained fact is unpaired. */
export const movedFrom = (moves, facts) => {
  const gained = facts.filter((fact) => moves.gained.has(fact.node_id));
  if (gained.length === 0) return null;
  const sources = gained.map((fact) => moves.pairs.get(fact.node_id));
  return sources.every(Boolean) ? sources : null;
};
