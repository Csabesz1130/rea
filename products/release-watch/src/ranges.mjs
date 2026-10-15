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
