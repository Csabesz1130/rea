// Sites a release gained and lost in one fact family, paired one to one
// across its components: a gained site that takes a lost site of the same
// method and value is a move, not new behaviour. Each lost site explains at
// most one gained site. An old site the new facts lack is lost only when
// its file is gone from its component's new side or changed there and REA
// examined it in full: one in a file the new side still ships unchanged
// was not removed, and one in a file REA could not fully examine there, or
// in a component whose new side REA could not analyze, is unknown now, not
// gone. A lost site whose file content the new release now ships under
// another path moved with its file and pairs only with a site in that copy.

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

// What became of one old site the new facts lack (see the top of this
// file): "kept", "unknown" or "lost".
const fateOf = (component, fact) => {
  const { digests, partial, comparable } = component;
  const module = fact.data.module;
  const before = digests?.left.get(module) ?? null;
  if (before !== null && before === digests?.right.get(module)) return "kept";
  if (!comparable || partial?.(module)) return "unknown";
  return "lost";
};

// The contents the new release ships at a path where its component's old
// side had other content or no file: where a file that moved now is.
const copiedContent = (components) => {
  const copies = new Set();
  for (const { digests } of components)
    for (const [module, digest] of digests?.right ?? [])
      if (digests.left.get(module) !== digest) copies.add(digest);
  return copies;
};

// The sites each component gained and lost, and the old sites that are
// unknown now.
const changedSites = (components, field) => {
  const sites = { gained: [], lost: [], unknown: [] };
  const all = () => true;
  for (const component of components)
    for (const item of component.items) {
      const { name, digests, keep } = component;
      const right = item.right.filter(keep?.right ?? all);
      const left = item.left.filter(keep?.left ?? all);
      for (const fact of unmatched(right, left, field))
        sites.gained.push({
          component: name,
          fact,
          digest: digests?.right.get(fact.data.module) ?? null,
        });
      for (const fact of unmatched(left, right, field)) {
        const fate = fateOf(component, fact);
        if (fate === "kept") continue;
        sites[fate].push({
          component: name,
          fact,
          digest: digests?.left.get(fact.data.module) ?? null,
        });
      }
    }
  return sites;
};

/**
 * `{ gained, pairs, lost, unknown, counterparts }` for one family: the
 * node ids of every gained site, a Map from each gained site paired with a
 * lost one to `{ component, fact }`, every lost site, the old sites that
 * are unknown now (`{ component, fact }`, in a file REA could not fully
 * examine on the new side or a component whose new side it could not
 * analyze), and a Map from each unpaired gained site to the unknown sites
 * it may be (unknownCounterparts).
 * `components` is `[{ name, items, comparable, digests, partial, keep }]`,
 * with `items` the keyed diff of the family, `digests` `{ left, right }`
 * maps of module to SHA-256, `partial` a test for the new side's files REA
 * examined only in part, and `keep` optional `{ left, right }` tests that
 * select the facts of each side that take part (requests without a known
 * destination). `unresolvedPairs` lets two sites with no value pair (such
 * requests), which process sites never do. `sameFile` says when two sites
 * must sit in the same file content to pair: "never", "across" components
 * (sites with nothing else that ties a site of one component to a site of
 * another), or "always" (sites whose meaning depends on the code around
 * them).
 */
export const releaseMoves = (
  components,
  { field, unresolvedPairs = false, sameFile = "never" },
) => {
  const { gained, lost, unknown } = changedSites(components, field);
  const copies = copiedContent(components);
  const sameDigest = (site, candidate) =>
    site.digest !== null && site.digest === candidate.digest;
  // A lost site whose file content moved to another path moved with it.
  const fileBound = (site, candidate, sameComponent) =>
    sameDigest(site, candidate) ||
    (!copies.has(candidate.digest) &&
      (sameFile === "never" || (sameFile === "across" && sameComponent)));
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
  // An unknown site never pairs; an unpaired gained site with its method
  // and value, an unresolved value matching an unresolved one, where its
  // file allows a pair, may be it.
  const counterparts = new Map();
  for (const site of gained) {
    if (pairs.has(site.fact.node_id)) continue;
    const found = unknown.filter(
      (old) =>
        old.fact.data.method === site.fact.data.method &&
        (old.fact.data[field] ?? null) === (site.fact.data[field] ?? null) &&
        fileBound(site, old, old.component === site.component),
    );
    if (found.length > 0) counterparts.set(site.fact.node_id, found);
  }
  return {
    gained: new Set(gained.map((site) => site.fact.node_id)),
    pairs,
    lost,
    unknown,
    counterparts,
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

/**
 * The old sites unknown now that a site among `facts` the release gained,
 * which no lost site accounts for, may be, moved: Release Watch cannot
 * tell whether they are gone, so they never pair (releaseMoves).
 */
export const unknownCounterparts = (moves, facts) => [
  ...new Set(
    facts.flatMap((fact) => moves.counterparts?.get(fact.node_id) ?? []),
  ),
];

/**
 * The sites a family lost with this method and no value (`field`): a gained
 * site without one never pairs with them, so it may be one of them, moved.
 */
export const lostUnresolved = (moves, method, field) =>
  moves.lost.filter(
    (site) => site.fact.data.method === method && site.fact.data[field] == null,
  );

/** The paired lost sites of a group's gained facts, or null when any gained fact is unpaired. */
export const movedFrom = (moves, facts) => {
  const gained = facts.filter((fact) => moves.gained.has(fact.node_id));
  if (gained.length === 0) return null;
  const sources = gained.map((fact) => moves.pairs.get(fact.node_id));
  return sources.every(Boolean) ? sources : null;
};
