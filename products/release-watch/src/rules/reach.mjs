// How a range of code (an IPC handler, an MCP tool registration) reaches
// process-execution sites. From the range, Release Watch follows REA's
// resolved same-module calls, reads of bindings that name functions, and
// imports into the function the importing module names (through REA's
// imported and exported names, namespace member reads and re-exports). An
// import REA links to a module but Release Watch cannot resolve to one of its
// functions reaches every process site of that module, so a gap in the call
// graph is never read as no reach. Every path is Release Watch's correlation
// of REA facts, so callers label it heuristic.
import { within } from "./shared.mjs";

const MAX_DEPTH = 8;
const MAX_EXPORT_HOPS = 5;
const indexes = new WeakMap();

const startsBefore = (a, b) =>
  a.start.line - b.start.line || a.start.column - b.start.column;
const sameStart = (a, b) =>
  a.start.line === b.start.line && a.start.column === b.start.column;

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

// Items of a module whose range lies within `range`, from a list sorted by start.
const inside = (list = [], range) => {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (startsBefore(list[middle].range, range) < 0) low = middle + 1;
    else high = middle;
  }
  const found = [];
  for (let index = low; index < list.length; index += 1) {
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
    functions,
    scope,
    calls: groupByModule(app.calls ?? [], (call) => call.module),
    reads: groupByModule(
      app.bindingReads.map((read) => ({ read, range: read.data.range })),
      (item) => item.read.data.module,
    ),
    members: groupByModule(app.members ?? [], (member) => member.module),
    execs: groupByModule(execs, (item) => item.exec.data.module),
    reached: new Map(),
  };
};

const indexOf = (app) => {
  if (!indexes.has(app)) indexes.set(app, buildIndex(app));
  return indexes.get(app);
};

const topLevel = (index, module, name) =>
  (index.functions.get(module) ?? []).find(
    (fn) => fn.name === name && index.scope.get(fn.id) === null,
  ) ?? null;

// The function a same-module binding names: a declaration (REA gives the
// declaration's binding the function itself as owner) or a function assigned
// to the binding in the binding's own scope.
const localFunction = (index, module, binding) => {
  const declared = index.byId.get(binding.owner);
  if (declared?.name === binding.name && within(binding.range, declared.range))
    return declared;
  return (
    (index.functions.get(module) ?? []).find(
      (fn) =>
        fn.name === binding.name &&
        index.scope.get(fn.id) === (binding.owner ?? null) &&
        startsBefore(binding.range, fn.range) <= 0,
    ) ?? null
  );
};

// The function a module exports under `name`, following re-exports.
const exportedFunction = ({ app, index }, module, name, hops = 0) => {
  const entry = app.modules.get(module);
  const local = entry?.exports?.get(name);
  if (local) return topLevel(index, module, local);
  const forwarded = entry?.reexports?.get(name);
  if (forwarded && hops < MAX_EXPORT_HOPS)
    return exportedFunction(
      { app, index },
      forwarded.module,
      forwarded.name,
      hops + 1,
    );
  // CommonJS objects (module.exports = { name }) export top-level names.
  return topLevel(index, module, name);
};

// Where a read of an imported binding leads: one function, or the whole
// module when the import cannot be resolved to one.
const importTarget = (app, index, item, imported) => {
  const { module, name } = imported;
  if (name !== "*" && name !== "default")
    return { module, fn: exportedFunction({ app, index }, module, name) };
  const member = (index.members.get(item.read.data.module) ?? []).find(
    (candidate) => sameStart(candidate.range, item.range),
  );
  if (member)
    return {
      module,
      member: member.path[0],
      fn: exportedFunction({ app, index }, module, member.path[0]),
    };
  return { module, fn: exportedFunction({ app, index }, module, "default") };
};

const readStep = (item, kind, extra = {}) => ({
  kind,
  name: item.read.data.name,
  location: item.read.location,
  ...extra,
});

// The next places a read leads to, with the step that explains it.
const followRead = (app, index, item) => {
  const { data } = item.read;
  const binding = {
    name: data.name,
    range: data.binding_range,
    owner: data.binding_owner ?? null,
  };
  const imported =
    binding.owner === null
      ? app.modules.get(data.module)?.imported?.get(data.name)
      : null;
  if (!imported) {
    const fn = binding.range
      ? localFunction(index, data.module, binding)
      : null;
    return fn ? [{ fn, step: readStep(item, "local") }] : [];
  }
  const target = importTarget(app, index, item, imported);
  const step = readStep(item, target.fn ? "import" : "unresolved-import", {
    module: target.module,
    imported: target.member ?? imported.name,
  });
  return target.fn
    ? [{ fn: target.fn, step }]
    : [{ module: target.module, step }];
};

const callStep = (fn) => ({ kind: "call", name: fn.name, location: null });

/** Every process site reachable from `{ module, range }`: a Map from exec node id to `{ exec, steps }`. */
export const reachedFrom = (app, { module, range }) => {
  const index = indexOf(app);
  const key = `${module}|${JSON.stringify(range)}`;
  if (!index.reached.has(key))
    index.reached.set(key, search(app, index, { module, range }));
  return index.reached.get(key);
};

const search = (app, index, { module, range }) => {
  const reached = new Map();
  const seen = new Set();
  const queue = [{ module, range, steps: [] }];
  const visit = (target, steps) => {
    const key = target.fn ? target.fn.id : `module:${target.module}`;
    if (seen.has(key) || steps.length > MAX_DEPTH) return;
    seen.add(key);
    queue.push(
      target.fn
        ? { module: target.fn.module, range: target.fn.range, steps }
        : { module: target.module, range: null, steps },
    );
  };
  for (let next = 0; next < queue.length; next += 1) {
    const { module: current, range: where, steps } = queue[next];
    const all = index.execs.get(current) ?? [];
    for (const { exec } of where ? inside(all, where) : all)
      if (!reached.has(exec.node_id))
        reached.set(exec.node_id, { exec, steps });
    if (where === null) continue;
    for (const call of inside(index.calls.get(current), where))
      for (const id of call.callees) {
        const fn = index.byId.get(id);
        if (fn) visit({ fn }, [...steps, callStep(fn)]);
      }
    for (const item of inside(index.reads.get(current), where))
      for (const next of followRead(app, index, item))
        visit(next, [...steps, next.step]);
  }
  return reached;
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
 * `{ kind, steps, read }` with kind inline, local-helper, imported or
 * unresolved-import, and `read` the first read step, for citing.
 */
export const reachOf = (app, scope, exec) => {
  if (scope.module === null || scope.range === null) return null;
  const found = reachedFrom(app, scope).get(exec.node_id);
  if (!found) return null;
  return {
    kind: kindOf(found.steps),
    steps: found.steps,
    read: found.steps.find((step) => step.location) ?? null,
  };
};

const stepText = (step) => {
  if (step.kind === "call")
    return `calls ${step.name ?? "a function"} through a call REA resolved`;
  if (step.kind === "local")
    return `reads ${step.name}, a function in the same module`;
  const imported =
    step.imported === step.name
      ? step.name
      : `${step.imported} as ${step.name}`;
  if (step.kind === "import")
    return `reads ${imported}, imported from ${step.module}`;
  return `reads ${imported}, imported from ${step.module}, which Release Watch could not resolve to one of its functions`;
};

/** The unknown a finding carries when a reach path crosses an unresolved import. */
export const reachUnknowns = (paths) =>
  paths.some((path) => path?.kind === "unresolved-import")
    ? [
        "Release Watch could not resolve an import to one of its module's functions, so it took every process site of that module as reachable.",
      ]
    : [];

/** One heuristic sentence for a reach path; `owner` names the code that reaches, in lower case. */
export const reachClaim = (path, exec, owner) => {
  const subject = `${owner[0].toUpperCase()}${owner.slice(1)}`;
  if (path.kind === "inline")
    return `${subject} contains ${exec.data.method}() in its source range`;
  const chain = path.steps.map(stepText).join(", which ");
  const holder =
    path.kind === "unresolved-import"
      ? `; that module holds ${exec.data.method}()`
      : `; its body holds ${exec.data.method}()`;
  return `${subject} ${chain}${holder}. REA reports each read, import and function; Release Watch connects them`;
};
