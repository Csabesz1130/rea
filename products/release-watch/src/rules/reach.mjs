// How a range of code (an IPC handler, an MCP tool registration) reaches
// process-execution sites. From the range, Release Watch follows REA's
// resolved same-module calls, every binding read (reach-resolve.mjs says
// where each leads), member reads on a receiver REA does not resolve
// (`this.run()`, reach-this.mjs) and member calls on a `new` expression REA
// resolved (`new Svc().run()`), breadth first, once per place. A class runs
// as it is constructed: its code outside its methods, the constructor's
// included; another method runs only when something calls it. Every path
// is Release Watch's correlation of REA facts, so callers label it
// heuristic (reach-text.mjs words it).
import { firstStarting, sameRange, sameStart, within } from "../ranges.mjs";
import {
  callRole,
  constructedRead,
  givesEntries,
  givesKeys,
  givesOneElement,
  isOwnReceiver,
  runningCall,
} from "./reach-calls.mjs";
import { entryPath } from "./reach-builtins.mjs";
import {
  WHOLE_MODULE,
  childFunctions,
  enclosingFunction,
  indexOf,
  initializes,
  inside,
  memberOn,
} from "./reach-index.mjs";
import { followRead, producedBy } from "./reach-resolve.mjs";
import { isGuess } from "./reach-text.mjs";
import { followBareMember } from "./reach-this.mjs";
import { outermostIn, outsideOf } from "./reach-value.mjs";

// Path length bound; the search is already bounded by visiting each
// function once, so this only cuts pathological chains.
const MAX_DEPTH = 32;

const callStep = (fn) => ({
  kind: "call",
  name: fn.name,
  location: null,
  constructs: fn.kind === "class",
});

// A class's methods, which constructing it does not run.
const methodsOf = (index, fn) =>
  childFunctions(index, fn.module, fn.id).filter(
    (child) => child.kind === "method" && child.name !== "constructor",
  );

// The methods of a class a `new` expression constructs whose instance no
// binding REA reports takes and no member call is made on: it is passed,
// returned or stored whole (`server.addTool(new GitTool())`, `return new
// Svc()`, `this.git = new Git()`), and what then calls its methods REA's
// facts do not show: each, as a guess.
const leftMethods = (index, module, call, fn) => {
  if (fn.kind !== "class" || initializes(index, module, call.range)) return [];
  if (memberOn(index, module, call.range)) return [];
  return methodsOf(index, fn).map((method) => ({
    fn: method,
    step: {
      kind: "passed",
      name: method.name,
      owner: fn.name,
      how: "guess",
      location: null,
    },
  }));
};

// The methods a member call on a `new` expression REA resolved to a class
// names (`new Svc().run()`), each with its step.
const instanceMethods = (index, module, member) => {
  const at = member.receiver.range;
  const calls = index.calls.get(module) ?? [];
  const classes = [];
  for (
    let next = firstStarting(calls, at);
    next < calls.length && sameStart(calls[next].range, at);
    next += 1
  )
    if (sameRange(calls[next].range, at))
      for (const id of calls[next].callees) {
        const fn = index.byId.get(id);
        if (fn?.kind === "class") classes.push(fn);
      }
  return classes.flatMap((owner) =>
    methodsOf(index, owner)
      .filter((fn) => fn.name === member.path[0])
      .map((fn) => ({
        fn,
        step: {
          kind: "constructed",
          name: fn.name,
          owner: owner.name,
          location: member.location,
        },
      })),
  );
};

const keyOf = (target) => {
  if (target.fn) return target.fn.id;
  if (target.region) {
    const { module, parts, path, element = false } = target.region;
    return `value:${module}:${JSON.stringify(parts[0].start)}:${parts.length}:${element}:${path?.join(".") ?? ""}`;
  }
  return `module:${target.whole}`;
};

// Code that runs when the place runs: its process sites, the calls REA
// resolved, the bindings it reads (except a receiver a method is bound back
// to, which the method reaches only through `this`) and the methods a
// member read names on `this`, or on what REA's nodes do not show is not
// `this` (reach-this.mjs).
const exploreCode = ({ state, record, visit }, entry) => {
  const { index } = state;
  const { module: current, range: where, steps, except = [] } = entry;
  const runs = (list) =>
    inside(list, where).filter(
      (item) => !except.some((range) => within(item.range, range)),
    );
  for (const { exec } of runs(index.execs.get(current))) record(exec, steps);
  for (const call of runs(index.calls.get(current)))
    for (const fn of call.callees.map((id) => index.byId.get(id))) {
      if (!fn) continue;
      visit({ fn }, [...steps, callStep(fn)]);
      for (const target of leftMethods(index, current, call, fn))
        visit(target, [...steps, target.step]);
    }
  for (const item of runs(index.reads.get(current)))
    if (!isOwnReceiver(index, current, item))
      for (const target of followRead(state, item))
        visit(target, [...steps, target.step]);
  for (const member of runs(index.members.get(current))) {
    const { receiver } = member;
    // REA's nodes may leave `this` out of the receiver (`(x || this).run`).
    if (receiver === null || receiver.range === null || receiver.room)
      for (const target of followBareMember(state, member))
        visit(target, [...steps, ...target.steps]);
    if (receiver?.range)
      for (const target of instanceMethods(index, current, member))
        visit(target, [...steps, target.step]);
  }
};

// Steps through a part of a value that may belong to a statement after it
// (reach-value.mjs) say so.
const marked = (steps, open) =>
  open ? [{ ...steps[0], open: true }, ...steps.slice(1)] : steps;

// The call giving `[key, value]` pairs a read is part of: the read's own
// `entries()` call, or an `Object.entries(…)` call around it; null for none.
const pairsCall = (role, level, item) =>
  role?.kind === "entries"
    ? role.call
    : (level.entries.find((call) => within(item.range, call.range)) ?? null);

// One read at an initializer's own level: a value it holds (forwarding the
// member read that reached the value), a call it makes when the module
// loads (only what the call produces), the elements of a value a built-in
// method gives (`TOOLS.find(…)`, and through the `[key, value]` pairs of
// `TOOLS.entries()` or `Object.entries(TOOLS)`: the path starts at one pair
// when it is below each element of the value or a method such as `find()`
// takes one, else at the array of them), or no function (`handlers.keys()`,
// a key of such a pair, or a receiver a method is bound back to).
const levelRead = ({ state, visit }, entry, item, level) => {
  const { index } = state;
  const { module, steps, path, uncertain = [], element = false } = entry;
  const { local } = level;
  if (isOwnReceiver(index, module, item)) return;
  const open = uncertain.some((range) => within(item.range, range));
  const go = (target, more) => visit(target, [...steps, ...marked(more, open)]);
  const role = level.constructs.has(item)
    ? { kind: "call", call: level.constructs.get(item) }
    : callRole(index, module, item);
  if (role?.kind === "keys") return;
  if (role?.kind !== "call") {
    const pairs = pairsCall(role, level, item);
    const taken = pairs
      ? entryPath(path, element || givesOneElement(index, module, pairs))
      : path;
    if (taken === undefined) return;
    // Below each element of the value, or, from pairs, of what they pair.
    const from = {
      path: taken,
      base: entry.base,
      element: element || Boolean(pairs),
    };
    for (const target of followRead(state, item, from))
      go(target, [target.step]);
    return;
  }
  for (const target of followRead(state, item))
    for (const made of producedBy(index, target, role.call, {
      path,
      element,
      local,
    }))
      go(made, [target.step, made.step]);
};

// An initializer, which runs when the module loads, not when the handler
// does: what its own level reads is part of the value (functions it holds
// are explored as values elsewhere), what it gives `Object.keys` holds no
// function, and a function it runs there (`(() => …)()`) gives the value
// only what it returns.
const exploreValue = (context, entry) => {
  const { index } = context.state;
  const { module, parts, steps, path, uncertain = [], element } = entry;
  const defined = outermostIn(index, module, parts);
  const level = outsideOf(defined);
  // A value in a function is given when that function runs.
  const local =
    parts.length > 0 && enclosingFunction(index, module, parts[0]) !== null;
  const constructs = new Map();
  const keys = [];
  const entries = [];
  for (const part of parts)
    for (const call of inside(index.callSites.get(module), part)) {
      if (!level(call.range)) continue;
      if (call.construct) {
        const read = constructedRead(index, module, call);
        if (read) constructs.set(read, call);
      } else if (givesKeys(index, module, call)) keys.push(call.range);
      else if (givesEntries(index, module, call)) entries.push(call);
    }
  for (const fn of defined) {
    const call = runningCall(index, fn);
    const open = uncertain.some((range) => within(fn.range, range));
    if (call)
      for (const made of producedBy(index, { fn }, call, {
        path,
        element,
        local,
      }))
        context.visit(made, [
          ...steps,
          ...marked([{ ...made.step, kind: "runs" }], open),
        ]);
  }
  for (const part of parts)
    for (const item of inside(index.reads.get(module), part))
      if (level(item.range) && !keys.some((range) => within(item.range, range)))
        levelRead(context, entry, item, { constructs, entries, local });
};

// Where a target's code runs: a function's range, without a class's
// methods (`methodsOf`); a value's region; or a whole module.
const placeOf = (index, target, steps) => {
  const { fn } = target;
  if (fn)
    return {
      module: fn.module,
      range: fn.range,
      steps,
      except:
        fn.kind === "class"
          ? methodsOf(index, fn).map((method) => method.range)
          : [],
    };
  if (target.region) return { ...target.region, steps, value: true };
  return { module: target.whole, range: WHOLE_MODULE, steps };
};

// Breadth first, every path REA's facts settle before any path through a
// guess (a member read Release Watch could not resolve to one function),
// so a process site is reported through a guess only when nothing else
// reaches it.
const search = (app, index, { module, range }) => {
  const reached = new Map();
  const seen = new Map();
  const queues = { settled: [{ module, range, steps: [] }], guessed: [] };
  const state = { app, index };
  const visit = (target, steps) => {
    const key = keyOf(target);
    const guessed = steps.some(isGuess);
    if (steps.length > MAX_DEPTH || seen.get(key) === "settled") return;
    if (seen.has(key) && guessed) return;
    seen.set(key, guessed ? "guessed" : "settled");
    queues[guessed ? "guessed" : "settled"].push({
      ...placeOf(index, target, steps),
      key,
    });
  };
  // Settled places are all explored first, so the first path recorded wins.
  const record = (exec, steps) => {
    if (!reached.has(exec.node_id)) reached.set(exec.node_id, { exec, steps });
  };
  for (const name of ["settled", "guessed"])
    for (let next = 0; next < queues[name].length; next += 1) {
      const place = queues[name][next];
      // Reached by a settled path after it was queued through a guess.
      if (name === "guessed" && seen.get(place.key) === "settled") continue;
      (place.value ? exploreValue : exploreCode)(
        { state, record, visit },
        place,
      );
    }
  return reached;
};

/** Every process site reachable from `{ module, range }`: a Map from exec node id to `{ exec, steps }`. */
export const reachedFrom = (app, { module, range }) => {
  const index = indexOf(app);
  const key = `${module}|${JSON.stringify(range)}`;
  if (!index.reached.has(key))
    index.reached.set(key, search(app, index, { module, range }));
  return index.reached.get(key);
};

const kindOf = (steps) => {
  if (steps.length === 0) return "inline";
  if (steps.some((step) => step.kind === "unresolved-import"))
    return "unresolved-import";
  return steps.some((step) => step.kind === "import")
    ? "imported"
    : "local-helper";
};

/**
 * The way code in `module` within `range` reaches `exec`, or null:
 * `{ kind, steps, read, guess }` with kind inline, local-helper, imported
 * or unresolved-import, `read` the first read step, for citing, and
 * `guess` set when a step followed every candidate of a member read.
 */
export const reachOf = (app, scope, exec) => {
  if (scope.module === null || scope.range === null) return null;
  const found = reachedFrom(app, scope).get(exec.node_id);
  if (!found) return null;
  return {
    kind: kindOf(found.steps),
    steps: found.steps,
    read: found.steps.find((step) => step.location) ?? null,
    guess: found.steps.some(isGuess),
  };
};
