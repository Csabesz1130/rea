// Source ranges as REA reports them: `{ start, end }`, each a line and a
// column. One owner for comparing them, for the facts and the rules.

const before = (a, b) =>
  a.line < b.line || (a.line === b.line && a.column <= b.column);

/** True when source range `inner` lies inside `outer`. */
export const within = (inner, outer) =>
  inner != null &&
  outer != null &&
  before(outer.start, inner.start) &&
  before(inner.end, outer.end);

/** Orders two ranges by where they start: negative when `a` starts first. */
export const startsBefore = (a, b) =>
  a.start.line - b.start.line || a.start.column - b.start.column;

/** True when two ranges start at the same position. */
export const sameStart = (a, b) =>
  a.start.line === b.start.line && a.start.column === b.start.column;

/** True when position `a` comes strictly before position `b`. */
export const comesBefore = (a, b) =>
  a.line < b.line || (a.line === b.line && a.column < b.column);

/** True when two ranges start and end at the same positions. */
export const sameRange = (a, b) =>
  sameStart(a, b) && a.end.line === b.end.line && a.end.column === b.end.column;

/** True when `inner` lies inside `outer` and is not the same range. */
export const strictlyWithin = (inner, outer) =>
  within(inner, outer) && !sameRange(inner, outer);

/**
 * In a list sorted by start, the position of the first item that starts at
 * or after `range` (with `after`, strictly after it). `rangeOf` reads an
 * item's range (its `range` by default).
 */
export const firstStarting = (
  list,
  range,
  { after = false, rangeOf = (item) => item.range } = {},
) => {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const order = startsBefore(rangeOf(list[middle]), range);
    if (order < 0 || (after && order === 0)) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Of call sites that start where a read starts (`candidates`), the
 * innermost one that ends after position `past`, the end of the read (its
 * callee or receiver), or null: a call that ends before it is one inside
 * the read's receiver (`getServer().setRequestHandler(…)`). `rangeOf`
 * reads a site's range (its `range` by default).
 */
export const innermostCall = (
  candidates,
  past,
  rangeOf = (site) => site.range,
) =>
  candidates.reduce((found, site) => {
    const { end } = rangeOf(site);
    return comesBefore(past, end) &&
      (found === null || comesBefore(end, rangeOf(found).end))
      ? site
      : found;
  }, null);
