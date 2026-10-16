// Release Watch's reading of JavaScript's built-in methods, which REA
// reports as member reads like any other: which run a callback for each
// element of their receiver, which give the receiver's elements, which give
// only its keys, which call or bind a function, and which add their
// arguments to the receiver. REA does not say which object a member read
// is on, so reach reads these names this way wherever REA reports them.

/** Methods that run a callback for each element of their receiver. */
export const ITERATION_METHODS = new Set([
  "forEach",
  "map",
  "flatMap",
  "filter",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
  "some",
  "every",
  "reduce",
  "reduceRight",
]);

/**
 * Iteration methods whose result holds nothing their callback returns: the
 * callback is not part of the value they give.
 */
export const PREDICATE_METHODS = new Set([
  "forEach",
  "filter",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
  "some",
  "every",
]);

/** Methods whose result holds the receiver's elements, entries or values. */
export const ELEMENT_METHODS = new Set([
  "filter",
  "find",
  "findLast",
  "slice",
  "concat",
  "at",
  "get",
  "values",
  "entries",
  "flat",
  "sort",
  "reverse",
  "toSorted",
  "toReversed",
  "toSpliced",
  "splice",
  "pop",
  "shift",
]);

/** Methods whose result holds only the receiver's keys. */
export const KEY_METHODS = new Set(["keys"]);

/** Functions of the global `Object` whose result holds only keys. */
export const OBJECT_KEY_FUNCTIONS = new Set(["keys", "getOwnPropertyNames"]);

/** Members that call a function rather than read one of its properties. */
export const CALL_MEMBERS = new Set(["call", "apply", "bind"]);

/** Members that run the function they are read on. */
export const RUN_MEMBERS = new Set(["call", "apply"]);

/**
 * Member reads that use a whole value rather than select one of its
 * properties: iterating it, taking its elements, looking an entry up,
 * calling it.
 */
export const WHOLE_VALUE_MEMBERS = new Set([
  ...ITERATION_METHODS,
  ...ELEMENT_METHODS,
  ...CALL_MEMBERS,
]);

/** Methods whose arguments become part of the receiver. */
export const ADDERS = new Set(["push", "unshift", "set", "add"]);
