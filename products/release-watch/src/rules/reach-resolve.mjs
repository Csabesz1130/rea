// Where a binding read leads, from REA's facts: the function a binding
// names (a declaration, or a function its initializer assigns) or the
// method of it a member read names; what an object, table or instance
// binding holds (reach-region.mjs places it, reach-value.mjs says what a
// read of it gives); a parameter of a callback an iteration method runs,
// to the elements it iterates (reach-calls.mjs finds the iteration); and
// imports through REA's imported names, export bindings, named, namespace
// and star re-exports. An import that names no function, object or value
// Release Watch can find in its module is "unknown": the whole module is
// then followed, so a gap in the call graph is never read as no reach.
import { startsBefore } from "../ranges.mjs";
import { CALL_MEMBERS, WHOLE_VALUE_MEMBERS } from "./reach-builtins.mjs";
import { iterationsOf } from "./reach-calls.mjs";
import { bindingAt, childFunctions, memberAt } from "./reach-index.mjs";
import { declaredFunction, valueRegion } from "./reach-region.mjs";
import { valueOf } from "./reach-value.mjs";

const MAX_EXPORT_HOPS = 8;

const topFunction = (index, module, name) =>
  childFunctions(index, module, null).find((fn) => fn.name === name) ?? null;
const topBinding = (index, module, name) =>
  (index.bindings.get(module) ?? []).find(
    (binding) => binding.name === name && binding.owner === null,
  ) ?? null;

/**
 * What a function gives a member read of it: itself (no member, or
 * `call`, `apply`, `bind`), the functions it defines under that name (a
 * class's methods, `prototype` members), or, when it defines none, all of
 * it as Release Watch's guess. A function a value holds that defines no
 * such member, when that value forwards the member read to it (`{ status,
 * deploy }`), is not a container of the member but may be it: a
 * "candidate".
 */
const functionMembers = (index, fn, path, forwarded = false) => {
  const member = path?.[0] === "prototype" ? path[1] : path?.[0];
  if (!member || CALL_MEMBERS.has(member))
    return { fns: [fn], how: "self", selects: null };
  const named = childFunctions(index, fn.module, fn.id).filter(
    (child) => child.name === member,
  );
  if (named.length > 0) return { fns: named, how: "member", selects: member };
  return { fns: [fn], how: forwarded ? "candidate" : "whole", selects: member };
};

// What a value binding, or an anonymous default export, gives a read with
// `path`: reach-value.mjs's answer, with the path the bindings it reads
// take when it only forwards them (`for (const tool of TOOLS)`, a spread).
// Built once per value and path: a binding can be read thousands of times.
const valueTargets = (index, value, path) => {
  const first = value.binding?.range ?? value.parts[0] ?? null;
  const key = `${value.module}\u0000${JSON.stringify(first?.start ?? null)}\u0000${value.binding ? "binding" : value.parts.length}\u0000${path?.join("\u0000") ?? ""}`;
  if (!index.values.has(key))
    index.values.set(key, resolveValue(index, value, path));
  return index.values.get(key);
};

// The path a value's reads take: the whole path when the value only
// forwards the bindings it reads, the rest of it after a written member.
const pathAfter = (how, path) => {
  if (how === "forward") return path;
  return how === "written" && path.length > 1 ? path.slice(1) : null;
};

const resolveValue = (index, value, path) => {
  const member = path?.[0] ?? null;
  const record = value.binding
    ? bindingAt(index, value.module, value.binding.range)
    : null;
  const region = value.binding
    ? valueRegion(index, value.module, value.binding)
    : { parts: value.parts, members: null, open: [], extended: false };
  const found = valueOf(
    index,
    {
      module: value.module,
      parts: region.parts,
      unwritten: region.unwritten ?? region.parts,
      members: region.members,
      open: region.open,
      iterated: record?.iterated ?? false,
      slots: record?.slots ?? [],
      // Slots describe the initializer; a later site can change any member.
      container: region.extended ? "partial" : (record?.container ?? null),
    },
    member,
  );
  return {
    fns: found.fns,
    region: found.region && {
      ...found.region,
      path: pathAfter(found.how, path),
    },
    how: found.how,
    selects: member,
    methods: found.methods ?? false,
    assigned: region.extended,
    unsure: found.unsure ?? null,
  };
};

// A module's own definition of an exported name: an anonymous default
// export by its range (a value: the function or object it is), else the
// module's one top-level function without a name (REA reports no export
// binding for `export default function () {}`), else the top-level
// function or binding it names.
const ownExport = (index, module, name, exported) => {
  if (exported?.local === null && exported.range)
    return { value: { module, parts: [exported.range] } };
  if (exported?.local === null || (!exported && name === "default")) {
    const unnamed = childFunctions(index, module, null).filter(
      (fn) => fn.name === null,
    );
    if (unnamed.length === 1) return { fn: unnamed[0] };
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

// A resolution found through `module`: `through` lists the modules it
// passed, from the one asked to the one that defines the name.
const passing = (module, found) =>
  found && !found.unknown
    ? { ...found, through: [module, ...(found.through ?? [])] }
    : found;

/**
 * What a module exports under `name`: `{ fn }`, `{ value }` (a binding that
 * is not a function, or an anonymous default export by its range), `{
 * namespace }` (another module) or `{ unknown }`. A resolution also lists in
 * `through` the modules it passed, from `module` to the one that defines
 * the name. The one owner of export resolution: reach and destination
 * attribution (destinations.mjs) both use it.
 */
export const exportTarget = ({ app, index }, module, name, hops = 0) => {
  const entry = app.modules.get(module);
  const exported = entry?.exports?.get(name);
  const local = exported?.local ?? name;
  // An exported local that is itself an import leads to its module first,
  // and so does a named re-export (`export { run } from "./shell.js"`),
  // whose export REA reports without a local binding, as it reports an
  // anonymous default export's.
  if (entry?.imported?.has(local) || entry?.reexports?.has(name))
    return (
      passing(
        module,
        forwardedTarget({ app, index }, entry, { name, local, hops }),
      ) ?? { unknown: module }
    );
  const own = ownExport(index, module, name, exported);
  if (own) return passing(module, own);
  for (const star of entry?.stars ?? [])
    if (hops < MAX_EXPORT_HOPS) {
      const found = exportTarget({ app, index }, star, name, hops + 1);
      if (!found.unknown) return passing(module, found);
    }
  return { unknown: module };
};

// Targets of one resolved export, with the member read that follows it.
const targetsOf = (state, target, path, forwarded) => {
  if (target.fn)
    return functionMembers(state.index, target.fn, path, forwarded);
  if (target.value) return valueTargets(state.index, target.value, path);
  if (target.namespace) {
    if (!path) return { unknown: target.namespace };
    return targetsOf(
      state,
      exportTarget(state, target.namespace, path[0]),
      path.slice(1).length > 0 ? path.slice(1) : null,
      forwarded,
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

// One target per function a resolution gives, and one for the value whose
// reads it follows; `open` marks a function that may belong to a statement
// after the value (reach-value.mjs).
const targetsWith = (resolved, stepOf) => [
  ...resolved.fns.map((fn) => ({
    fn,
    step: resolved.unsure?.has(fn) ? { ...stepOf(fn), open: true } : stepOf(fn),
  })),
  ...(resolved.region ? [{ region: resolved.region, step: stepOf(null) }] : []),
];

const importedReads = (state, item, imported, { path, forwarded }) => {
  const namespaced = imported.name === "*";
  const target = namespaced
    ? { namespace: imported.module }
    : exportTarget(state, imported.module, imported.name);
  const resolved = targetsOf(state, target, path, forwarded);
  const details = {
    module: imported.module,
    imported: (namespaced ? path?.[0] : imported.name) ?? imported.name,
    namespaced,
    forwarded,
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
  return targetsWith(resolved, (fn) =>
    step(item, "import", {
      ...details,
      how: resolved.how,
      selects: resolved.selects,
      methods: resolved.methods ?? false,
      target: fn?.name ?? null,
    }),
  );
};

// A parameter of a callback an iteration method runs leads to each element
// of each receiver it iterates, which takes the parameter's member read.
// REA does not say whether a parameter read with no member holds a whole
// element, a property of one (`({ name }) => …`) or a key, so all of each
// element is followed as Release Watch's guess. Other parameters are values
// callers pass, not followed.
const elementTargets = (state, item, path) => {
  const { index } = state;
  const owner = index.byId.get(item.read.data.binding_owner);
  if (!owner) return [];
  return iterationsOf(index, owner).map((iteration) => ({
    region: { module: owner.module, parts: [iteration.range], path },
    step: step(item, "element", {
      method: iteration.method,
      selects: path?.[0] ?? null,
      how: path ? "element" : "whole",
    }),
  }));
};

// The member path a read takes: its own member read, and when a value
// forwards a member read to the bindings it reads, that member after the
// read's own (a member that iterates or looks up the read value is not a
// property of it).
const pathOf = (index, item, forwarded) => {
  const own = memberAt(index, item.read.data.module, item.range)?.path ?? null;
  if (!forwarded) return own;
  return [
    ...(own && !WHOLE_VALUE_MEMBERS.has(own[0]) ? own : []),
    ...forwarded,
  ];
};

/**
 * The next places a binding read leads to, each with the step that
 * explains it. `forwarded` is a member path a value forwards to the
 * bindings its initializer reads.
 */
export const followRead = (state, item, forwarded = null) => {
  const { index } = state;
  const { data } = item.read;
  const path = pathOf(index, item, forwarded);
  if (data.parameter) return elementTargets(state, item, path);
  const binding = {
    name: data.name,
    range: data.binding_range,
    owner: data.binding_owner ?? null,
  };
  const imported =
    binding.owner === null
      ? state.app.modules.get(data.module)?.imported?.get(data.name)
      : null;
  const forwarding = forwarded !== null;
  if (imported)
    return importedReads(state, item, imported, {
      path,
      forwarded: forwarding,
    });
  if (!binding.range) return [];
  const fn = declaredFunction(index, data.module, binding);
  const found = fn
    ? functionMembers(index, fn, path, forwarding)
    : valueTargets(index, { module: data.module, binding }, path);
  return targetsWith(found, (target) =>
    step(item, fn ? "local" : target ? "value" : "initializer", {
      how: found.how,
      selects: found.selects,
      methods: found.methods ?? false,
      target: target?.name ?? null,
      forwarded: forwarding,
      assigned: found.assigned ?? false,
    }),
  );
};

const producedStep = (kind, extra) => ({ kind, location: null, ...extra });

/**
 * What a call an initializer makes when the module loads gives the value:
 * for `new`, the instance's methods (the one a member read names, else
 * each, as a guess when one is named); otherwise what the called function
 * returns. Code the call runs is not reached by reading the value.
 */
export const producedBy = (index, target, call, path) => {
  const member = path?.[0] ?? null;
  if (target.fn && call.construct) {
    const methods = childFunctions(
      index,
      target.fn.module,
      target.fn.id,
    ).filter((fn) => fn.name !== "constructor");
    const named = methods.filter((fn) => fn.name === member);
    const how = member === null ? "all" : named.length > 0 ? "named" : "guess";
    return (named.length > 0 ? named : methods).map((fn) => ({
      fn,
      step: producedStep("instance", { target: fn.name, selects: member, how }),
    }));
  }
  if (target.fn) {
    const parts = (index.returns.get(target.fn.id) ?? [])
      .map((site) => site.range)
      .sort(startsBefore);
    const found = valueTargets(
      index,
      { module: target.fn.module, parts },
      path,
    );
    return targetsWith(found, (fn) =>
      producedStep("returns", {
        target: fn?.name ?? null,
        selects: member,
        how: found.how,
      }),
    );
  }
  if (target.region)
    return [
      {
        region: { ...target.region, path: path ?? target.region.path },
        step: producedStep("returns", { selects: member, how: "forward" }),
      },
    ];
  return [{ ...target, step: producedStep("returns", { how: "all" }) }];
};
