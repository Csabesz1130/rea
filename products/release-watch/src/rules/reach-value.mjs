// What a value gives a read of it, from REA's facts: the functions it
// holds, those REA names after a member, those REA reports written to a
// member, and what REA's property slots say a member holds. A function the
// value's initializer runs when its statement runs (`(() => …)()`), or
// gives a built-in method as a callback whose result holds nothing it
// returns (`TOOLS.find((t) => …)`), is not one the value holds. Where a
// value lies is reach-region.mjs's; which call a function is passed to is
// reach-calls.mjs's.
import {
  comesBefore,
  firstStarting,
  sameStart,
  startsBefore,
  within,
} from "../ranges.mjs";
import { WHOLE_VALUE_MEMBERS } from "./reach-builtins.mjs";
import { calleeMember, isPredicate, runningCall } from "./reach-calls.mjs";
import { inside } from "./reach-index.mjs";
import { disjoint } from "./reach-region.mjs";

/** Functions that start in `parts` and are not nested in another of them. */
export const outermostIn = (index, module, parts) => {
  const list = index.functions.get(module) ?? [];
  const found = [];
  for (const part of parts)
    for (let next = firstStarting(list, part); next < list.length; next += 1) {
      const fn = list[next];
      if (!comesBefore(fn.range.start, part.end)) break;
      const last = found.at(-1);
      if (!last || !within(fn.range, last.range)) found.push(fn);
    }
  return found;
};

/**
 * The functions a value in `parts` holds: those it defines at its own
 * level, except one a call there runs or gives a built-in method as a
 * callback whose result holds nothing it returns.
 */
export const heldIn = (index, module, parts) =>
  outermostIn(index, module, parts).filter(
    (fn) => !runningCall(index, fn) && !isPredicate(index, fn),
  );

/**
 * A predicate for items of `range` that are not inside one of `fns`, the
 * functions the range defines (sorted by start).
 */
export const outsideOf = (fns) => (range) => {
  const at = firstStarting(fns, range, { after: true }) - 1;
  return at < 0 || !within(range, fns[at].range);
};

const CONSTANTS = new Set(["literal", "union"]);
const CONTAINERS = new Set(["object", "array"]);
const slotTrees = new WeakMap();

// REA's slots of one initializer by the path of the container holding them.
const slotChildren = (slots) => {
  if (!slotTrees.has(slots)) {
    const children = new Map();
    for (const slot of slots) {
      const parent = JSON.stringify(slot.path.slice(0, -1));
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(slot);
    }
    slotTrees.set(slots, children);
  }
  return slotTrees.get(slots);
};

// A slot REA shows holds no function: a literal, or a container REA saw
// whole whose slots hold none.
const holdsNoFunction = (slot, children) =>
  CONSTANTS.has(slot.value) ||
  (CONTAINERS.has(slot.value) &&
    slot.complete &&
    (children.get(JSON.stringify(slot.path)) ?? []).every((child) =>
      holdsNoFunction(child, children),
    ));

// REA's slots of a container REA saw whole that nothing after its
// declaration changes, those that may hold a function, and whether the
// value holds no more values than those slots: REA does not report where
// a literal ends, and a statement after it can look like part of it. A
// container REA saw only in part can hold any number.
const slotFacts = ({ slots = [], container = null }, held) => {
  if (container !== "complete") return null;
  const open = slots.filter(
    (slot) =>
      !CONSTANTS.has(slot.value) &&
      !(CONTAINERS.has(slot.value) && slot.complete),
  );
  return {
    children: slotChildren(slots),
    open,
    bounded:
      !open.some((slot) => CONTAINERS.has(slot.value)) && held <= open.length,
  };
};

// True when REA's slots show the member, or that member of every element
// of a table, holds no function.
const holdsConstant = (slots, facts, member) => {
  const own = slots.filter(
    (slot) =>
      slot.path.at(-1) === member &&
      (slot.path.length === 1 ||
        (slot.path.length === 2 && /^\d+$/.test(slot.path[0]))),
  );
  return (
    own.length > 0 && own.every((slot) => holdsNoFunction(slot, facts.children))
  );
};

// A method REA reports is the member its name gives (a class or object
// method, named by its key); any other function could be any member's.
const couldBe = (member) => (fn) =>
  fn.name === member || fn.kind !== "method" || fn.name === null;

// The values the parts hold at their own level, outside the functions they
// define, as Release Watch counts them: each function that could be the
// member, and each call and binding read there that is not part of another
// one (`wrap(fn)`, `a.b`).
const levelValues = (index, { module, parts, defined, candidates }) => {
  const level = outsideOf(defined);
  const items = candidates.map((fn) => fn.range);
  for (const part of parts)
    for (const list of [index.callSites.get(module), index.reads.get(module)])
      for (const item of inside(list, part))
        if (level(item.range)) items.push(item.range);
  items.sort(startsBefore);
  let count = 0;
  let last = null;
  for (const range of items)
    if (!last || !within(range, last)) {
      count += 1;
      last = range;
    }
  return count;
};

// The member's values when REA reports where it is written and the parts
// no member write places define no function it could also be: the
// functions those writes give and those REA names after it.
const writtenAnswer = (index, value, { member, written, rest }) => {
  if (!written || rest.some((fn) => fn.name !== member && couldBe(member)(fn)))
    return null;
  return {
    fns: [
      ...heldIn(index, value.module, written),
      ...rest.filter((fn) => fn.name === member),
    ],
    region: { module: value.module, parts: written },
    how: "written",
  };
};

// A member read of what REA did not report written to that member.
// `methods` marks an answer that leaves out the methods REA names after
// other members.
const memberOf = (index, value, { member, own, fns }) => {
  const region = own.length > 0 ? { module: value.module, parts: own } : null;
  const named = fns.filter((fn) => fn.name === member);
  if (named.length > 0) return { fns: named, region: null, how: "named" };
  const candidates = fns.filter(couldBe(member));
  const methods = new Set(
    fns.filter((fn) => !couldBe(member)(fn)).map((fn) => fn.name),
  );
  const items = levelValues(index, {
    module: value.module,
    parts: own,
    defined: outermostIn(index, value.module, own),
    candidates,
  });
  const facts = slotFacts(value, items + methods.size);
  if (facts && holdsConstant(value.slots, facts, member))
    return { fns: [], region: null, how: "constant" };
  // REA's open slots that are not those methods' all hold the member.
  const others = facts?.open.filter((slot) => !methods.has(slot.path.at(-1)));
  if (
    facts?.bounded &&
    others.length > 0 &&
    others.every((slot) => slot.path.at(-1) === member)
  )
    return { fns: candidates, region, how: "slots", methods: methods.size > 0 };
  if (candidates.length === 0 && (value.container ?? null) === null)
    return { fns: candidates, region, how: "forward" };
  return { fns: candidates, region, how: "guess", methods: methods.size > 0 };
};

// What a call gives after its callee: from the end of the member read or
// the read it calls (the start of a call of an expression) to its end.
const afterCallee = (index, module, call) => {
  const callee = calleeMember(index, module, call);
  const reads = index.reads.get(module) ?? [];
  const read = reads[firstStarting(reads, call.range)];
  const start =
    callee?.range.end ??
    (read && sameStart(read.range, call.range) ? read.range.end : null) ??
    call.range.start;
  return { start, end: call.range.end };
};

// The call a `for…of` binding iterates or a destructuring destructures
// (`of Object.entries(ALL)`, `= Object.entries(H)[0]`), whose value starts
// where its pattern or name ends: the first call at the value's level, when
// no read there starts before it.
const leadingCall = (index, value, calls, level) => {
  const [first] = calls;
  if (!(value.iterated || value.destructured) || !first) return null;
  const reads = value.open.flatMap((part) =>
    inside(index.reads.get(value.module), part).filter((item) =>
      level(item.range),
    ),
  );
  return reads.some((item) => startsBefore(item.range, first.range) < 0)
    ? null
    : first;
};

// The calls at the level of the parts whose end Release Watch placed
// (reach-region.mjs), as far as they can be statements after the value
// (`watch(…, () => …)` after a handler map) rather than part of it: all of
// them, except the expression a `for…of` binding iterates or a
// destructuring destructures and the calls in it, and none when REA's slots
// show the value holds no more values than they do.
const statementCalls = (index, value, defined) => {
  const { module, parts, open } = value;
  const held = levelValues(index, {
    module,
    parts,
    defined,
    candidates: heldIn(index, module, parts),
  });
  if (slotFacts(value, held)?.bounded) return [];
  const level = outsideOf(defined);
  const calls = open.flatMap((part) =>
    inside(index.callSites.get(module), part).filter((call) =>
      level(call.range),
    ),
  );
  const leading = leadingCall(index, value, calls, level);
  return leading
    ? calls.filter((call) => !within(call.range, leading.range))
    : calls;
};

// The arguments of those calls, built once per value.
const uncertainIn = (index, value) => {
  const { module, parts, open = [] } = value;
  if (open.length === 0) return [];
  const key = `${module}\u0000${JSON.stringify(parts[0]?.start ?? null)}\u0000${parts.length}`;
  if (index.uncertain.has(key)) return index.uncertain.get(key);
  const defined = outermostIn(index, module, parts);
  const found = disjoint(
    statementCalls(index, value, defined).map((call) =>
      afterCallee(index, module, call),
    ),
  );
  index.uncertain.set(key, found);
  return found;
};

const memberAnswer = (index, value, member) => {
  const { module, parts } = value;
  if (member === null || WHOLE_VALUE_MEMBERS.has(member))
    return {
      fns: heldIn(index, module, parts),
      region: parts.length > 0 ? { module, parts } : null,
      how: "all",
    };
  const written = value.members?.get(member) ?? null;
  const unwritten = value.unwritten ?? parts;
  const rest = heldIn(index, module, unwritten);
  const answer = writtenAnswer(index, value, { member, written, rest });
  if (answer) return answer;
  const own = written ? disjoint([...unwritten, ...written]) : unwritten;
  const fns = written ? heldIn(index, module, own) : rest;
  return memberOf(index, value, { member, own, fns });
};

/**
 * What a value gives a read of it. Without a member, or with one that uses
 * the whole value, everything it holds ("all"). With a member, only what no
 * write REA reports places under another member, and: what REA reports
 * written to it ("written"); the functions REA names after it ("named");
 * nothing when REA's slots show the member holds no function ("constant");
 * everything when REA's slots show only that member can hold a function
 * besides the methods REA names after other members ("slots"); the member
 * of the values it reads when it defines no function and REA reports no
 * slots for it ("forward"); otherwise every value that could be the member,
 * as Release Watch's guess. `unsure` holds the functions, and the region's
 * `uncertain` the ranges, that may belong to a statement after the value.
 */
export const valueOf = (index, value, member) => {
  const answer = memberAnswer(index, value, member);
  const uncertain = uncertainIn(index, value);
  if (uncertain.length === 0) return answer;
  const unsure = new Set(
    answer.fns.filter((fn) =>
      uncertain.some((range) => within(fn.range, range)),
    ),
  );
  return {
    ...answer,
    unsure,
    region: answer.region && { ...answer.region, uncertain },
  };
};
