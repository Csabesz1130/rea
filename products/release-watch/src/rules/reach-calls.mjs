// The calls around a range, from REA's call sites, arguments and member
// reads: the member read a call calls, the call a function or argument is
// passed to, whether a call runs a function it is written around when its
// statement runs (`(() => …)()`), and the iteration calls a callback is
// passed to, inline or through the binding that names it. REA reports no
// syntax tree; these are Release Watch's correlations of REA's ranges.
import {
  comesBefore,
  firstStarting,
  sameRange,
  sameStart,
  startsBefore,
  within,
} from "../ranges.mjs";
import { callStartingAt, readsOfBinding, scopeOf } from "./reach-index.mjs";
import { declaredFunction } from "./reach-region.mjs";
import {
  CALL_MEMBERS,
  ENTRY_METHODS,
  ITERATION_METHODS,
  KEY_METHODS,
  OBJECT_KEY_FUNCTIONS,
  ONE_ELEMENT_METHODS,
  PREDICATE_METHODS,
  RUN_MEMBERS,
  WHOLE_VALUE_MEMBERS,
} from "./reach-builtins.mjs";

/** The innermost call site of `module` that holds `range` and is not it, or null. */
export const callHolding = (index, module, range) => {
  const calls = index.callSites.get(module) ?? [];
  let found = null;
  for (
    let next = firstStarting(calls, range, { after: true }) - 1;
    next >= 0;
    next -= 1
  ) {
    const call = calls[next];
    if (found && !sameStart(call.range, found.range)) break;
    if (
      within(range, call.range) &&
      !sameRange(range, call.range) &&
      (!found || within(call.range, found.range))
    )
      found = call;
  }
  return found;
};

/**
 * The member read a call calls (`TOOLS.forEach` in `TOOLS.forEach(cb)`):
 * of the member reads starting where the call starts, the one that ends
 * last within it. A member read starting there that ends within the call
 * ends before its arguments; one on its result ends after it. Null for a
 * call of a plain name or of an expression.
 */
export const calleeMember = (index, module, call) => {
  const members = index.members.get(module) ?? [];
  let callee = null;
  for (
    let next = firstStarting(members, call.range);
    next < members.length && sameStart(members[next].range, call.range);
    next += 1
  ) {
    const { end } = members[next].range;
    if (
      comesBefore(end, call.range.end) &&
      (!callee || comesBefore(callee.range.end, end))
    )
      callee = members[next];
  }
  return callee;
};

/** The argument that starts where `range` starts and holds it, or null. */
const argumentAt = (index, module, range) => {
  const args = index.arguments.get(module) ?? [];
  let found = null;
  for (
    let next = firstStarting(args, range);
    next < args.length && sameStart(args[next].range, range);
    next += 1
  )
    if (within(range, args[next].range)) found = args[next];
  return found;
};

// True when an argument of `call` holds `range`.
const inArgument = (index, module, call, range) => {
  const args = index.arguments.get(module) ?? [];
  for (
    let next = firstStarting(args, call.range);
    next < args.length && !comesBefore(range.start, args[next].range.start);
    next += 1
  )
    if (within(range, args[next].range) && within(args[next].range, call.range))
      return true;
  return false;
};

/**
 * How the innermost call around a function uses it, built once per
 * function: `{ call, callee, argument, passed }`, with `callee` the call's
 * member read, `argument` the argument that is the function
 * (`TOOLS.find((t) => …)`), and `passed` false when no argument holds the
 * function, which is then written where the call calls (`(() => …)()`).
 */
const usedBy = (index, fn) => {
  if (index.used.has(fn.id)) return index.used.get(fn.id);
  const around = callHolding(index, fn.module, fn.range);
  // A call in another function than the one `fn` is defined in holds that
  // function, not `fn` (`(() => ({ run: () => … }))()`).
  const call = around?.owner === scopeOf(index, fn) ? around : null;
  const found = call && {
    call,
    callee: calleeMember(index, fn.module, call),
    argument: argumentAt(index, fn.module, fn.range),
    passed: inArgument(index, fn.module, call, fn.range),
  };
  index.used.set(fn.id, found ?? null);
  return found ?? null;
};

/**
 * The call that runs `fn` where its statement runs: a call written around
 * the function rather than given it as an argument (`(() => …)()`, or
 * through `.call` and `.apply`), or null.
 */
export const runningCall = (index, fn) => {
  const used = usedBy(index, fn);
  if (!used || used.passed || used.call.construct) return null;
  const method = used.callee?.path.at(-1);
  return used.callee === null || RUN_MEMBERS.has(method) ? used.call : null;
};

/**
 * True when `fn` is the callback of a built-in method whose result holds
 * nothing the callback returns (`TOOLS.find((t) => …)`, `forEach`).
 */
export const isPredicate = (index, fn) => {
  const used = usedBy(index, fn);
  return (
    Boolean(used?.argument) && PREDICATE_METHODS.has(used.callee?.path.at(-1))
  );
};

// The iteration a call is, when its argument at `argument` is the callback:
// the method its member read names, and the receiver it iterates.
const iterationAt = (index, module, argument) => {
  const call = callHolding(index, module, argument.range);
  const callee = call && calleeMember(index, module, call);
  const method = callee?.path.at(-1);
  return ITERATION_METHODS.has(method) ? { method, range: callee.range } : null;
};

// The bindings that name `fn`: its declaration, or a binding assigned it.
const bindingsNaming = (index, fn) =>
  (index.bindings.get(fn.module) ?? []).filter(
    (binding) =>
      binding.name === fn.name &&
      declaredFunction(index, fn.module, binding) === fn,
  );

// Each read of a binding that names `fn` that is a whole argument.
const passedByName = (index, fn) =>
  fn.name === null
    ? []
    : bindingsNaming(index, fn).flatMap((binding) =>
        readsOfBinding(index, fn.module, binding.range).flatMap(({ range }) => {
          const argument = argumentAt(index, fn.module, range);
          return argument && sameRange(argument.range, range) ? [argument] : [];
        }),
      );

/**
 * The iteration calls `fn` is the callback of, built once per function:
 * each `{ method, range }`, with the member read's range as the receiver it
 * iterates. The callback is passed inline (`TOOLS.forEach((tool) => …)`)
 * or by a binding that names it (`TOOLS.forEach(register)`).
 */
export const iterationsOf = (index, fn) => {
  if (index.elements.has(fn.id)) return index.elements.get(fn.id);
  const inline = argumentAt(index, fn.module, fn.range);
  const found = (inline ? [inline] : passedByName(index, fn))
    .map((argument) => iterationAt(index, fn.module, argument))
    .filter(Boolean);
  index.elements.set(fn.id, found);
  return found;
};

/**
 * True when a read is the receiver a method is bound back to: the first
 * argument of a `.call`, `.apply` or `.bind` call on a member of the same
 * binding (`repo.status.bind(repo)`). The method reaches that receiver's
 * other members only through `this`, which reach follows by name.
 */
export const isOwnReceiver = (index, module, item) => {
  const argument = argumentAt(index, module, item.range);
  if (
    !argument ||
    argument.position !== 0 ||
    !sameRange(argument.range, item.range)
  )
    return false;
  const call = callHolding(index, module, argument.range);
  const callee = call && calleeMember(index, module, call);
  if (!CALL_MEMBERS.has(callee?.path.at(-1)) || callee.path.length < 2)
    return false;
  const reads = index.reads.get(module) ?? [];
  const receiver = reads[firstStarting(reads, call.range)];
  const own = receiver?.read.data.binding_range;
  const bound = item.read.data.binding_range;
  return (
    receiver !== undefined &&
    sameStart(receiver.range, call.range) &&
    receiver.read.data.name === item.read.data.name &&
    Boolean(own && bound) &&
    sameStart(own, bound)
  );
};

/**
 * The read a `new` expression constructs: the first read in it that starts
 * before its arguments.
 */
export const constructedRead = (index, module, call) => {
  const reads = index.reads.get(module) ?? [];
  const first = reads[firstStarting(reads, call.range)];
  if (!first || !within(first.range, call.range)) return null;
  const args = index.arguments.get(module) ?? [];
  const argument = args[firstStarting(args, call.range)];
  return argument &&
    within(argument.range, call.range) &&
    startsBefore(argument.range, first.range) <= 0
    ? null
    : first;
};

/**
 * What a call an initializer makes with `read` as its callee or receiver
 * does with it, by the call's member read: `call` (`f()`, `f.call()`,
 * `api.make()`: the value is what the function returns), `value` (`f.bind()`:
 * the function itself), `elements` (`TOOLS.find(…)`, `slice`, `concat`,
 * `get`: the receiver's elements), `keys` (`handlers.keys()`: no function),
 * `entries` (`TOOLS.entries()`: `[key, value]` pairs), or null when no call
 * there has it as callee.
 */
export const callRole = (index, module, read) => {
  const call = callStartingAt(index, module, read.range, read.range.end);
  if (!call) return null;
  const path = calleeMember(index, module, call)?.path ?? [];
  const method = path.at(-1);
  if (path.length === 0 || RUN_MEMBERS.has(method))
    return { kind: "call", call };
  if (method === "bind") return { kind: "value", call };
  if (path.length === 1 && KEY_METHODS.has(method))
    return { kind: "keys", call };
  if (path.length === 1 && ENTRY_METHODS.has(method))
    return { kind: "entries", call };
  if (WHOLE_VALUE_MEMBERS.has(method)) return { kind: "elements", call };
  return { kind: "call", call };
};

/**
 * True when `call` is one of `Object`'s functions whose result holds only
 * the keys of its argument (`Object.keys(handlers)`).
 */
export const givesKeys = (index, module, call) =>
  objectCall(index, module, call, OBJECT_KEY_FUNCTIONS);

/**
 * True when `call` is `Object.entries(…)`, whose result holds `[key,
 * value]` pairs of its argument.
 */
export const givesEntries = (index, module, call) =>
  objectCall(index, module, call, ENTRY_METHODS);

/**
 * True when a method whose result is one element of its receiver is called
 * on `call`'s result (`Object.entries(H).find(…)`).
 */
export const givesOneElement = (index, module, call) => {
  const outer = callStartingAt(index, module, call.range, call.range.end);
  const callee = outer && calleeMember(index, module, outer);
  return (
    Boolean(callee?.receiver?.range) &&
    sameRange(callee.receiver.range, call.range) &&
    callee.path.length === 1 &&
    ONE_ELEMENT_METHODS.has(callee.path[0])
  );
};

// True when `call` calls one of `names` on the global `Object`.
const objectCall = (index, module, call, names) => {
  const callee = calleeMember(index, module, call);
  return (
    callee?.receiver?.global === "Object" &&
    callee.path.length === 1 &&
    names.has(callee.path[0])
  );
};
