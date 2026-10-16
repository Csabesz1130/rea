// The lookup structures reachability needs, built once per app from REA's
// semantic facts: functions by module, name and enclosing scope, and the
// calls, call sites, arguments, return sites, binding and parameter reads,
// member reads, class field keys, property writes, assignments, bindings,
// statement markers, export statements and process sites of each module
// sorted by position.
import { sameStart, startsBefore, within } from "../ranges.mjs";

const indexes = new WeakMap();

/** The range that stands for a whole module, or a scope with no end. */
export const WHOLE_MODULE = {
  start: { line: 0, column: 0 },
  end: { line: Number.MAX_SAFE_INTEGER, column: 0 },
};

const groupByModule = (items = [], moduleOf) => {
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

const listsBy = (items, keyOf) => {
  const lists = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!lists.has(key)) lists.set(key, []);
    lists.get(key).push(item);
  }
  return lists;
};

const positionKey = (module, range) =>
  `${module}\u0000${range.start.line}:${range.start.column}`;

// The source ranges REA reports for the named exports of each module: an
// `export const TOOLS = [...]` statement's range ends where its initializer
// does.
const exportRanges = (modules = new Map()) =>
  groupByModule(
    [...modules].flatMap(([module, entry]) =>
      [...(entry.exports?.values() ?? [])]
        .filter((exported) => exported.local !== null && exported.range)
        .map((exported) => ({ module, range: exported.range })),
    ),
    (item) => item.module,
  );

const buildIndex = (app) => {
  const all = app.functions ?? [];
  const functions = groupByModule(all, (fn) => fn.module);
  const scope = new Map();
  for (const list of functions.values())
    for (const [id, owner] of scopesOf(list)) scope.set(id, owner);
  const execs = app.childProcesses
    .filter((exec) => exec.data.range)
    .map((exec) => ({ exec, range: exec.data.range }));
  const reads = groupByModule(
    [...app.bindingReads, ...(app.parameterReads ?? [])].map((read) => ({
      read,
      range: read.data.range,
    })),
    (item) => item.read.data.module,
  );
  // Each binding's reads in source order, for where its initializer ends.
  const byBinding = new Map();
  for (const list of reads.values())
    for (const item of list) {
      const { module, binding_range: bound } = item.read.data;
      if (!bound || item.read.data.parameter) continue;
      const key = positionKey(module, bound);
      if (!byBinding.has(key)) byBinding.set(key, []);
      byBinding.get(key).push(item);
    }
  return {
    byId: new Map(all.map((fn) => [fn.id, fn])),
    named: listsBy(all, (fn) => `${fn.module}\u0000${fn.name}`),
    children: listsBy(
      all,
      (fn) => `${fn.module}\u0000${scope.get(fn.id) ?? ""}`,
    ),
    functions,
    scope,
    calls: groupByModule(app.calls, (call) => call.module),
    callSites: groupByModule(app.callSites, (call) => call.module),
    arguments: groupByModule(app.arguments, (item) => item.module),
    returns: listsBy(app.returns ?? [], (item) => item.owner),
    reads,
    byBinding,
    members: groupByModule(app.members, (member) => member.module),
    fields: groupByModule(app.fields, (field) => field.module),
    writes: groupByModule(app.propertyWrites, (write) => write.module),
    assignments: groupByModule(
      (app.bindings ?? []).flatMap((binding) =>
        (binding.assignments ?? []).map((range) => ({
          module: binding.module,
          range,
        })),
      ),
      (assignment) => assignment.module,
    ),
    bindings: groupByModule(app.bindings, (binding) => binding.module),
    bindingAt: new Map(
      (app.bindings ?? []).map((binding) => [
        positionKey(binding.module, binding.range),
        binding,
      ]),
    ),
    markers: groupByModule(app.markers, (marker) => marker.module),
    exports: exportRanges(app.modules),
    execs: groupByModule(execs, (item) => item.exec.data.module),
    reached: new Map(),
    sites: new Map(),
    regions: new Map(),
    values: new Map(),
    elements: new Map(),
    used: new Map(),
    uncertain: new Map(),
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

/** The innermost function enclosing `fn`, or null at the top of its module. */
export const scopeOf = (index, fn) => index.scope.get(fn.id) ?? null;

/** Functions directly inside scope `scope` (a function id, or null for the module). */
export const childFunctions = (index, module, scope) =>
  index.children.get(`${module}\u0000${scope ?? ""}`) ?? [];

/** The reads of the binding REA reports at `range` in `module`, in source order. */
export const readsOfBinding = (index, module, range) =>
  index.byBinding.get(positionKey(module, range)) ?? [];

/** REA's binding node at `range` in `module`, or null. */
export const bindingAt = (index, module, range) =>
  index.bindingAt.get(positionKey(module, range)) ?? null;

/**
 * The innermost function of a module that contains `range`: the last one
 * starting at or before it, or one of the functions enclosing that one.
 */
export const enclosingFunction = (index, module, range) => {
  const list = index.functions.get(module) ?? [];
  const last = firstStarting(list, range, { after: true }) - 1;
  for (let fn = list[last]; fn; fn = index.byId.get(scopeOf(index, fn)))
    if (within(range, fn.range)) return fn;
  return null;
};

/**
 * The member read that starts where `range` starts, the innermost when a
 * chain of calls starts there too (`handlers.list().forEach`), or null.
 */
export const memberAt = (index, module, range) => {
  const members = index.members.get(module) ?? [];
  let found = null;
  for (
    let next = firstStarting(members, range);
    next < members.length && sameStart(members[next].range, range);
    next += 1
  )
    if (
      !found ||
      startsBefore(
        { start: members[next].range.end },
        { start: found.range.end },
      ) < 0
    )
      found = members[next];
  return found;
};

/** The property write that starts where `range` starts (`handlers.git = …` at `handlers`), or null. */
export const writeAt = (index, module, range) => {
  const writes = index.writes.get(module) ?? [];
  const found = writes[firstStarting(writes, range)];
  return found && sameStart(found.range, range) ? found : null;
};
