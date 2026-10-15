// The lookup structures reachability needs, built once per app from REA's
// semantic facts: functions by module and name with their enclosing scope,
// and the calls, binding reads, member reads, bindings and process sites of
// each module sorted by position.
import { startsBefore, within } from "../ranges.mjs";

const indexes = new WeakMap();

const groupByModule = (items, moduleOf) => {
  const groups = new Map();
  for (const item of items) {
    const key = moduleOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const list of groups.values())
    list.sort((a, b) => startsBefore(a.range, b.range));
  return groups;
};

/**
 * In a list sorted by start, the position of the first item that starts at
 * or after `range` (with `after`, strictly after it).
 */
export const firstStarting = (list, range, { after = false } = {}) => {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const order = startsBefore(list[middle].range, range);
    if (order < 0 || (after && order === 0)) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** Items of a module whose range lies within `range`, from a list sorted by start. */
export const inside = (list = [], range) => {
  const found = [];
  for (
    let index = firstStarting(list, range);
    index < list.length;
    index += 1
  ) {
    const item = list[index];
    if (startsBefore({ start: range.end }, item.range) < 0) break;
    if (within(item.range, range)) found.push(item);
  }
  return found;
};

// The innermost function strictly enclosing each function of one module.
const scopesOf = (functions) => {
  const scope = new Map();
  const stack = [];
  for (const fn of functions) {
    while (stack.length > 0 && !within(fn.range, stack.at(-1).range))
      stack.pop();
    scope.set(fn.id, stack.at(-1)?.id ?? null);
    stack.push(fn);
  }
  return scope;
};

const byName = (functions) => {
  const names = new Map();
  for (const fn of functions) {
    const key = `${fn.module}\u0000${fn.name}`;
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(fn);
  }
  return names;
};

const buildIndex = (app) => {
  const functions = groupByModule(app.functions ?? [], (fn) => fn.module);
  const scope = new Map();
  for (const list of functions.values())
    for (const [id, owner] of scopesOf(list)) scope.set(id, owner);
  const execs = app.childProcesses
    .filter((exec) => exec.data.range)
    .map((exec) => ({ exec, range: exec.data.range }));
  return {
    byId: new Map((app.functions ?? []).map((fn) => [fn.id, fn])),
    named: byName(app.functions ?? []),
    functions,
    scope,
    calls: groupByModule(app.calls ?? [], (call) => call.module),
    reads: groupByModule(
      app.bindingReads.map((read) => ({ read, range: read.data.range })),
      (item) => item.read.data.module,
    ),
    members: groupByModule(app.members ?? [], (member) => member.module),
    bindings: groupByModule(app.bindings ?? [], (binding) => binding.module),
    execs: groupByModule(execs, (item) => item.exec.data.module),
    reached: new Map(),
    regions: new Map(),
  };
};

/** The reach index of one app, built on first use. */
export const indexOf = (app) => {
  if (!indexes.has(app)) indexes.set(app, buildIndex(app));
  return indexes.get(app);
};

/** Functions named `name` in `module`. */
export const namedFunctions = (index, module, name) =>
  index.named.get(`${module}\u0000${name}`) ?? [];
