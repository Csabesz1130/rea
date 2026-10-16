// How a range of code (an IPC handler, an MCP tool registration) reaches
// process-execution sites. From the range, Release Watch follows REA's
// resolved same-module calls, every binding read (reach-resolve.mjs says
// where each leads) and member reads on a receiver REA does not resolve
// (`this.run()`, reach-this.mjs), breadth first, once per place. Every
// path is Release Watch's correlation of REA facts, so callers label it
// heuristic (reach-text.mjs words it).
import { within } from "../ranges.mjs";
import {
  callRole,
  constructedRead,
  givesKeys,
  isOwnReceiver,
  runningCall,
} from "./reach-calls.mjs";
import { WHOLE_MODULE, indexOf, inside } from "./reach-index.mjs";
import { followRead, producedBy } from "./reach-resolve.mjs";
import { isGuess } from "./reach-text.mjs";
import { followBareMember } from "./reach-this.mjs";
import { outermostIn, outsideOf } from "./reach-value.mjs";

// Path length bound; the search is already bounded by visiting each
// function once, so this only cuts pathological chains.
const MAX_DEPTH = 32;

const callStep = (fn) => ({ kind: "call", name: fn.name, location: null });

const keyOf = (target) => {
  if (target.fn) return target.fn.id;
  if (target.region) {
    const { module, parts, path } = target.region;
    return `value:${module}:${JSON.stringify(parts[0].start)}:${parts.length}:${path?.join(".") ?? ""}`;
  }
  return `module:${target.whole}`;
};

// Code that runs when the place runs: its process sites, the calls REA
// resolved, the bindings it reads (except a receiver a method is bound back
// to, which the method reaches only through `this`) and the methods `this`
// names.
const exploreCode = ({ state, record, visit }, entry) => {
  const { index } = state;
  const { module: current, range: where, steps } = entry;
  for (const { exec } of inside(index.execs.get(current), where))
    record(exec, steps);
  for (const call of inside(index.calls.get(current), where))
    for (const fn of call.callees.map((id) => index.byId.get(id)))
      if (fn) visit({ fn }, [...steps, callStep(fn)]);
  for (const item of inside(index.reads.get(current), where))
    if (!isOwnReceiver(index, current, item))
      for (const target of followRead(state, item))
        visit(target, [...steps, target.step]);
  for (const member of inside(index.members.get(current), where))
    if (member.bare)
      for (const target of followBareMember(state, member))
        visit(target, [...steps, ...target.steps]);
};

// Steps through a part of a value that may belong to a statement after it
// (reach-value.mjs) say so.
const marked = (steps, open) =>
  open ? [{ ...steps[0], open: true }, ...steps.slice(1)] : steps;

// One read at an initializer's own level: a value it holds (forwarding the
// member read that reached the value), a call it makes when the module
// loads (only what the call produces), the elements of a value a built-in
// method gives (`TOOLS.find(…)`), or no function (`handlers.keys()`, or a
// receiver a method is bound back to).
const levelRead = ({ state, visit }, entry, item, constructs) => {
  const { index } = state;
  const { module, steps, path, uncertain = [] } = entry;
  if (isOwnReceiver(index, module, item)) return;
  const open = uncertain.some((range) => within(item.range, range));
  const go = (target, more) => visit(target, [...steps, ...marked(more, open)]);
  const role = constructs.has(item)
    ? { kind: "call", call: constructs.get(item) }
    : callRole(index, module, item);
  if (role?.kind === "keys") return;
  if (role?.kind !== "call") {
    for (const target of followRead(state, item, path))
      go(target, [target.step]);
    return;
  }
  for (const target of followRead(state, item))
    for (const made of producedBy(index, target, role.call, path))
      go(made, [target.step, made.step]);
};

// An initializer, which runs when the module loads, not when the handler
// does: what its own level reads is part of the value (functions it holds
// are explored as values elsewhere), what it gives `Object.keys` holds no
// function, and a function it runs there (`(() => …)()`) gives the value
// only what it returns.
const exploreValue = (context, entry) => {
  const { index } = context.state;
  const { module, parts, steps, path, uncertain = [] } = entry;
  const defined = outermostIn(index, module, parts);
  const level = outsideOf(defined);
  const constructs = new Map();
  const keys = [];
  for (const part of parts)
    for (const call of inside(index.callSites.get(module), part)) {
      if (!level(call.range)) continue;
      if (call.construct) {
        const read = constructedRead(index, module, call);
        if (read) constructs.set(read, call);
      } else if (givesKeys(index, module, call)) keys.push(call.range);
    }
  for (const fn of defined) {
    const call = runningCall(index, fn);
    const open = uncertain.some((range) => within(fn.range, range));
    if (call)
      for (const made of producedBy(index, { fn }, call, path))
        context.visit(made, [
          ...steps,
          ...marked([{ ...made.step, kind: "runs" }], open),
        ]);
  }
  for (const part of parts)
    for (const item of inside(index.reads.get(module), part))
      if (level(item.range) && !keys.some((range) => within(item.range, range)))
        levelRead(context, entry, item, constructs);
};

const placeOf = (target, steps) => {
  if (target.fn)
    return { module: target.fn.module, range: target.fn.range, steps };
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
      ...placeOf(target, steps),
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
