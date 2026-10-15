// Where a binding read leads, from REA's facts: the function a binding names
// (a declaration, or a function its initializer assigns), the functions an
// object or table binding's initializer defines (a member read picks one by
// name), and imports through REA's imported names, export bindings, named,
// namespace and star re-exports. An import that names no function, object
// or value Release Watch can find in its module is "unknown": the whole
// module is then followed, so a gap in the call graph is never read as no
// reach. A value with no functions in its initializer reaches nothing.
import { sameStart, startsBefore, within } from "../ranges.mjs";
import { firstStarting, inside, namedFunctions } from "./reach-index.mjs";

const MAX_EXPORT_HOPS = 8;
// `const name = (` or `const name = async function (`: the gap between a
// binding and the function it is assigned.
const MAX_GAP = 40;
const WHOLE = {
  start: { line: 0, column: 0 },
  end: { line: Number.MAX_SAFE_INTEGER, column: 0 },
};

const scopeOf = (index, fn) => index.scope.get(fn.id) ?? null;
const topFunction = (index, module, name) =>
  namedFunctions(index, module, name).find(
    (fn) => scopeOf(index, fn) === null,
  ) ?? null;
const topBinding = (index, module, name) =>
  (index.bindings.get(module) ?? []).find(
    (binding) => binding.name === name && binding.owner === null,
  ) ?? null;

// The function a binding's declaration or initializer is: REA gives a
// declaration's binding the declared function as owner; an assigned
// function starts just after the binding, in the binding's scope.
export const declaredFunction = (index, module, binding) => {
  const declared = index.byId.get(binding.owner);
  if (declared?.name === binding.name && within(binding.range, declared.range))
    return declared;
  const between = (fn) =>
    (index.bindings.get(module) ?? []).some(
      (other) =>
        other !== binding &&
        startsBefore({ start: binding.range.end }, other.range) < 0 &&
        startsBefore(other.range, fn.range) < 0,
    );
  return (
    namedFunctions(index, module, binding.name).find((fn) => {
      const { end } = binding.range;
      const { start } = fn.range;
      return (
        scopeOf(index, fn) === (binding.owner ?? null) &&
        startsBefore(binding.range, fn.range) <= 0 &&
        ((start.line === end.line && start.column - end.column <= MAX_GAP) ||
          (start.line === end.line + 1 && start.column <= MAX_GAP)) &&
        !between(fn)
      );
    }) ?? null
  );
};

// Where a later binding's statement starts: a declaration's binding sits
// after the `function` keyword, so its function's start is used instead.
const statementStart = (index, binding) => {
  const declared = index.byId.get(binding.owner);
  return declared?.name === binding.name &&
    within(binding.range, declared.range)
    ? declared.range.start
    : binding.range.start;
};

// The innermost function of a module that contains `range`: the last one
// starting at or before it, or one of the functions enclosing that one.
const enclosingFunction = (index, module, range) => {
  const list = index.functions.get(module) ?? [];
  const last = firstStarting(list, range, { after: true }) - 1;
  for (let fn = list[last]; fn; fn = index.byId.get(scopeOf(index, fn)))
    if (within(range, fn.range)) return fn;
  return null;
};

// An initializer cannot read its own binding outside a function it defines,
// so it ends before the first statement that does: the outermost call REA
// reports around that read, else the read itself.
const firstUse = (index, module, binding) => {
  const after = { start: binding.range.end };
  const use = (index.reads.get(module) ?? []).find(
    ({ read, range }) =>
      read.data.name === binding.name &&
      read.data.binding_range &&
      sameStart(read.data.binding_range, binding.range) &&
      startsBefore(after, range) <= 0 &&
      (enclosingFunction(index, module, range)?.id ?? null) ===
        (binding.owner ?? null),
  );
  if (!use) return null;
  const calls = index.calls.get(module) ?? [];
  for (let next = firstStarting(calls, after); next < calls.length; next += 1) {
    const call = calls[next];
    if (startsBefore(use.range, call.range) < 0) break;
    if (within(use.range, call.range)) return call.range.start;
  }
  return use.range.start;
};

// The source a binding's initializer can occupy: from the binding to the
// next binding's statement or the binding's first use, within the binding's
// own function.
const initializerRegion = (index, module, binding) => {
  const key = `${module}\u0000${JSON.stringify(binding.range.start)}`;
  if (!index.regions.has(key))
    index.regions.set(key, regionOf(index, module, binding));
  return index.regions.get(key);
};

const regionOf = (index, module, binding) => {
  const owner = index.byId.get(binding.owner);
  const limit = owner && !within(binding.range, owner.range) ? null : owner;
  let end = limit?.range.end ?? WHOLE.end;
  const used = firstUse(index, module, binding);
  if (used && startsBefore({ start: used }, { start: end }) < 0) end = used;
  for (const other of index.bindings.get(module) ?? []) {
    const begins = statementStart(index, other);
    if (
      startsBefore(binding.range, { start: begins }) < 0 &&
      startsBefore({ start: begins }, { start: end }) < 0
    )
      end = begins;
  }
  return { start: binding.range.start, end };
};

// Functions that start inside a region, not those that enclose it.
const startingIn = (functions = [], region) =>
  functions.filter(
    (fn) =>
      startsBefore({ start: region.start }, fn.range) <= 0 &&
      startsBefore(fn.range, { start: region.end }) < 0,
  );

// Where an object, array or instance binding leads. With a member read, the
// functions of that name its initializer defines, else a function of that
// name anywhere in the module (a class method). Otherwise, or when neither
// exists, the initializer itself: every function it defines (a tool table, a
// handler map) and the bindings it reads (`for (const tool of TOOLS)`).
const valueTargets = (index, module, binding, member) => {
  const region = initializerRegion(index, module, binding);
  const defined = startingIn(index.functions.get(module), region);
  if (member !== null) {
    const named = defined.filter((fn) => fn.name === member);
    if (named.length > 0) return { fns: named };
    const methods = namedFunctions(index, module, member);
    if (methods.length > 0) return { fns: methods };
  }
  return { fns: defined, region: { module, range: region } };
};

const memberAt = (index, module, range) =>
  (index.members.get(module) ?? []).find((candidate) =>
    sameStart(candidate.range, range),
  )?.path ?? null;

/**
 * What a module exports under `name`: `{ fn }`, `{ value }` (a binding that
 * is not a function), `{ namespace }` (another module) or `{ unknown }`.
 */
// A module's own definition of an exported name: an anonymous default
// export by its range, else the top-level function or binding it names.
// An anonymous default export, by its export range, else the module's one
// top-level function without a name (REA reports no export binding for
// `export default function () {}`).
const anonymousDefault = (index, module, exported) => {
  if (exported?.range) {
    const [fn] = inside(index.functions.get(module), exported.range);
    if (fn) return fn;
  }
  const unnamed = (index.functions.get(module) ?? []).filter(
    (fn) => fn.name === null && scopeOf(index, fn) === null,
  );
  return unnamed.length === 1 ? unnamed[0] : null;
};

const ownExport = (index, module, name, exported) => {
  if (
    (exported && exported.local === null) ||
    (!exported && name === "default")
  ) {
    const fn = anonymousDefault(index, module, exported);
    if (fn) return { fn };
  }
  const local = exported?.local ?? name;
  const fn = topFunction(index, module, local);
  if (fn) return { fn };
  const value = topBinding(index, module, local);
  return value ? { value: { module, binding: value } } : null;
};

// A name a module exports or holds by another route: an imported local it
// re-exports (`export default runShell`), or a named re-export.
const forwardedTarget = (state, entry, { name, local, hops }) => {
  const through = entry?.imported?.get(local) ?? entry?.reexports?.get(name);
  if (!through || hops >= MAX_EXPORT_HOPS) return null;
  return through.name === "*"
    ? { namespace: through.module }
    : exportTarget(state, through.module, through.name, hops + 1);
};

export const exportTarget = ({ app, index }, module, name, hops = 0) => {
  const entry = app.modules.get(module);
  const exported = entry?.exports?.get(name);
  const local = exported?.local ?? name;
  // An exported local that is itself an import leads to its module first.
  if (entry?.imported?.has(local))
    return forwardedTarget({ app, index }, entry, { name, local, hops });
  const own = ownExport(index, module, name, exported);
  if (own) return own;
  const forwarded = forwardedTarget({ app, index }, entry, {
    name,
    local: null,
    hops,
  });
  if (forwarded) return forwarded;
  for (const star of entry?.stars ?? [])
    if (hops < MAX_EXPORT_HOPS) {
      const found = exportTarget({ app, index }, star, name, hops + 1);
      if (!found.unknown) return found;
    }
  return { unknown: module };
};

// Targets of one resolved export, with the member read that follows it.
const targetsOf = (state, target, path) => {
  if (target.fn) return { fns: [target.fn] };
  if (target.value)
    return valueTargets(
      state.index,
      target.value.module,
      target.value.binding,
      path?.[0] ?? null,
    );
  if (target.namespace) {
    if (!path) return { unknown: target.namespace };
    return targetsOf(
      state,
      exportTarget(state, target.namespace, path[0]),
      path.slice(1).length > 0 ? path.slice(1) : null,
    );
  }
  return { unknown: target.unknown };
};

const step = (item, kind, extra = {}) => ({
  kind,
  name: item.read.data.name,
  location: item.read.location,
  ...extra,
});

const importedReads = (state, item, imported, path) => {
  const target =
    imported.name === "*"
      ? { namespace: imported.module }
      : exportTarget(state, imported.module, imported.name);
  const resolved = targetsOf(state, target, path);
  const shown = imported.name === "*" ? path?.[0] : imported.name;
  const details = {
    module: imported.module,
    imported: shown ?? imported.name,
    member: imported.name === "*",
  };
  if (resolved.unknown)
    return [
      {
        whole: resolved.unknown,
        step: step(item, "unresolved-import", {
          ...details,
          module: resolved.unknown,
        }),
      },
    ];
  return [
    ...resolved.fns.map((fn) => ({ fn, step: step(item, "import", details) })),
    ...(resolved.region
      ? [{ region: resolved.region, step: step(item, "import", details) }]
      : []),
  ];
};

/** The next places a binding read leads to, each with the step that explains it. */
export const followRead = (state, item) => {
  const { data } = item.read;
  const binding = {
    name: data.name,
    range: data.binding_range,
    owner: data.binding_owner ?? null,
  };
  const path = memberAt(state.index, data.module, item.range);
  const imported =
    binding.owner === null
      ? state.app.modules.get(data.module)?.imported?.get(data.name)
      : null;
  if (imported) return importedReads(state, item, imported, path);
  if (!binding.range) return [];
  const fn = declaredFunction(state.index, data.module, binding);
  if (fn) return [{ fn, step: step(item, "local") }];
  const member = path?.[0] ?? null;
  const value = valueTargets(state.index, data.module, binding, member);
  return [
    ...value.fns.map((target) => ({
      fn: target,
      step: step(item, "value", { member, target: target.name }),
    })),
    ...(value.region
      ? [{ region: value.region, step: step(item, "initializer") }]
      : []),
  ];
};

/** The range that stands for a whole module when an import cannot be resolved. */
export const WHOLE_MODULE = WHOLE;
