// Where a binding read leads, from REA's facts: the function a binding
// names (a declaration, or a function its initializer assigns) or the
// method of it a member read names; what an object, table or instance
// binding holds (reach-region.mjs places it, reach-value.mjs says what a
// read of it gives); a parameter of a callback an iteration method runs,
// to the elements it iterates (reach-calls.mjs finds the iteration); and
// imports through REA's imported names and export resolution (named,
// namespace and star re-exports: facts/exports.mjs owns it). An import that
// names no function, object or value
// Release Watch can find in its module is "unknown": the whole module is
// then followed, so a gap in the call graph is never read as no reach.
import { resolveExport } from "../facts/exports.mjs";
import { sameStart, startsBefore } from "../ranges.mjs";
import {
  CALL_MEMBERS,
  ONE_ELEMENT_METHODS,
  WHOLE_VALUE_MEMBERS,
} from "./reach-builtins.mjs";
import { iterationsOf } from "./reach-calls.mjs";
import { bindingAt, childFunctions, memberOn } from "./reach-index.mjs";
import { declaredFunction, valueRegion } from "./reach-region.mjs";
import { valueOf } from "./reach-value.mjs";

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

// What a value binding, or a value by its range (an anonymous default
// export, a function's returns, a destructuring default), gives a read with
// `path`: reach-value.mjs's answer, with the path the bindings it reads
// take when it only forwards them (`for (const tool of TOOLS)`, a spread).
// `element` says the path is below each element of the value (a `for…of`
// element) rather than the value itself. Built once per value and path: a
// binding can be read thousands of times.
const valueTargets = (index, value, path, element = false) => {
  const first = value.binding?.range ?? value.parts[0] ?? null;
  const key = `${value.module}\u0000${JSON.stringify(first?.start ?? null)}\u0000${value.binding ? "binding" : value.parts.length}\u0000${element}\u0000${path?.join("\u0000") ?? ""}`;
  if (!index.values.has(key))
    index.values.set(key, resolveValue(index, value, { path, element }));
  return index.values.get(key);
};

// The path a value's reads take: the whole path when the value only
// forwards the bindings it reads, the rest of it after a written member.
const pathAfter = (how, path) => {
  if (how === "forward") return path;
  return how === "written" && path.length > 1 ? path.slice(1) : null;
};

// The path a read of a destructured binding takes in what its pattern
// destructures: REA's property path, then the read's own; null when REA did
// not resolve the property (a computed key, or what it destructures reads a
// computed member).
const destructuredPath = ({ path: own }, path) =>
  own === null ? null : [...own, ...(path ?? [])];

// What reach-value.mjs reads a value from: REA's binding record and where
// reach-region.mjs places its value, or an anonymous default export's own
// range.
const valueFacts = (index, value) => {
  if (!value.binding)
    return {
      record: null,
      extended: false,
      input: {
        module: value.module,
        parts: value.parts,
        unwritten: value.parts,
        members: null,
        open: [],
        iterated: false,
        destructured: false,
        slots: [],
        container: null,
      },
    };
  const record = bindingAt(index, value.module, value.binding.range);
  const region = valueRegion(index, value.module, value.binding);
  return {
    record,
    extended: region.extended,
    input: {
      module: value.module,
      parts: region.parts,
      unwritten: region.unwritten,
      members: region.members,
      open: region.open,
      iterated: record?.iterated ?? false,
      destructured: Boolean(record?.destructured),
      slots: record?.slots ?? [],
      // Slots describe the initializer; a later site can change any member.
      container: region.extended ? "partial" : (record?.container ?? null),
    },
  };
};

// The value's region, with the path its reads take below it: below each
// element when a `for…of` binding iterates it, or when the value forwards a
// path that already was (a destructured binding's path starts at its own
// expression, so it never is).
const resolveValue = (index, value, { path, element }) => {
  const { record, extended, input } = valueFacts(index, value);
  const destructured = record?.destructured ?? null;
  const read = destructured ? destructuredPath(destructured, path) : path;
  const member = read?.[0] ?? null;
  const found = valueOf(index, input, member);
  return {
    fns: found.fns,
    region: found.region && {
      ...found.region,
      path: pathAfter(found.how, read),
      base: destructured?.source ?? null,
      element:
        input.iterated ||
        (element && found.how === "forward" && destructured === null),
    },
    how: destructured && read === null ? "whole" : found.how,
    selects: member,
    methods: found.methods ?? false,
    assigned: extended,
    unsure: found.unsure ?? null,
    destructured: destructured && {
      path: destructured.path,
      iterated: record.iterated,
      computedKey: destructured.computedKey,
    },
  };
};

// A module's own definition of an exported name: an anonymous default
// export by its range (a value: the function or object it is), else the
// module's one top-level function without a name (REA reports no export
// binding for `export default function () {}`), else the top-level
// function or binding it names (for a name REA reports no export for,
// Release Watch's correlation).
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

/**
 * What a module exports under `name`: `{ fn }`, `{ value }` (a binding that
 * is not a function, or an anonymous default export by its range), `{
 * namespace }` (another module), `{ external }` (an external module's
 * export, which holds none of the release's functions) or `{ unknown }`. A
 * resolution also lists in `through` the modules it passed, from `module`
 * to the one that defines the name. facts/exports.mjs resolves the name;
 * reach and destination attribution (destinations.mjs) both use this.
 */
export const exportTarget = ({ app, index }, module, name) => {
  const found = resolveExport(app.modules, module, name, (at, own, exported) =>
    ownExport(index, at, own, exported),
  );
  if (found.unknown || found.namespace || found.external) return found;
  return found.defined
    ? { ...found.defined, through: found.through }
    : { unknown: found.module };
};

// Targets of one resolved export, with the member read that follows it;
// `via` says whether a value forwarded the path and whether it is below
// each element (`valueTargets`).
const targetsOf = (state, target, path, via) => {
  if (target.fn)
    return functionMembers(state.index, target.fn, path, via.forwarded);
  if (target.value)
    return valueTargets(state.index, target.value, path, via.element);
  if (target.namespace) {
    if (!path) return { unknown: target.namespace };
    return targetsOf(
      state,
      exportTarget(state, target.namespace, path[0]),
      path.slice(1).length > 0 ? path.slice(1) : null,
      { forwarded: via.forwarded, element: false },
    );
  }
  if (target.external) return { fns: [], how: "external", selects: null };
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

// The module that defines an imported name when the module it is imported
// from re-exports it (`export { runGit } from "../git.js"`), else null.
const definingModule = (state, imported, { target, path }) => {
  const found =
    imported.name !== "*"
      ? target
      : path
        ? exportTarget(state, imported.module, path[0])
        : null;
  const through = found?.through ?? [];
  return through.length > 1 ? through.at(-1) : null;
};

const importedReads = (state, item, imported, { path, forwarded, element }) => {
  const namespaced = imported.name === "*";
  const target = namespaced
    ? { namespace: imported.module }
    : exportTarget(state, imported.module, imported.name);
  const resolved = targetsOf(state, target, path, { forwarded, element });
  const details = {
    module: imported.module,
    defined: definingModule(state, imported, { target, path }),
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
    region: {
      module: owner.module,
      parts: [iteration.range],
      path,
      element: true,
    },
    step: step(item, "element", {
      method: iteration.method,
      selects: path?.[0] ?? null,
      how: path ? "element" : "whole",
    }),
  }));
};

// The member path a read takes, and whether it is below each element of
// the read value: its own member read, and when a value forwards a member
// read to the bindings it reads, that member after the read's own (a
// member that iterates or looks up the read value is not a property of
// it, and one that gives one element, `pairs.find(…)`, puts the path below
// it). A destructuring's path below the binding REA names as its source
// (`base`) already holds the member chain read on it.
const pathOf = (index, item, { path: forwarded, base, element }) => {
  const own = memberOn(index, item.read.data.module, item.range)?.path ?? null;
  if (!forwarded) return { path: own, element: false };
  const bound = item.read.data.binding_range;
  if (base && bound && sameStart(base, bound))
    return { path: forwarded, element };
  if (own && WHOLE_VALUE_MEMBERS.has(own[0]))
    return {
      path: forwarded,
      element: element || ONE_ELEMENT_METHODS.has(own[0]),
    };
  return { path: [...(own ?? []), ...forwarded], element: element && !own };
};

// A destructured binding's default value (`handler = noop`), which it holds
// when what its pattern destructures has no such property: a value of its
// own, read with the read's path rather than REA's property path.
const defaultTargets = (index, binding, { module, path, stepOf }) => {
  const range = bindingAt(index, module, binding.range)?.destructured
    ?.defaultValue;
  if (!range) return [];
  const found = valueTargets(index, { module, parts: [range] }, path);
  return targetsWith(found, (target) => ({
    ...stepOf(found, target),
    fallback: true,
    destructured: null,
  }));
};

/**
 * The next places a binding read leads to, each with the step that
 * explains it. `from.path` is a member path a value forwards to the
 * bindings its initializer reads, `from.element` says that path is below
 * each element of the read value, and `from.base` is the binding a
 * destructuring value's path is below (`resolveValue`).
 */
export const followRead = (state, item, from = {}) => {
  const { index } = state;
  const { data } = item.read;
  const { path, element } = pathOf(index, item, from);
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
  const forwarding = (from.path ?? null) !== null;
  if (imported)
    return importedReads(state, item, imported, {
      path,
      forwarded: forwarding,
      element,
    });
  if (!binding.range) return [];
  const fn = declaredFunction(index, data.module, binding);
  const found = fn
    ? functionMembers(index, fn, path, forwarding)
    : valueTargets(index, { module: data.module, binding }, path, element);
  const stepOf = (resolved, target) =>
    step(item, fn ? "local" : target ? "value" : "initializer", {
      how: resolved.how,
      selects: resolved.selects,
      methods: resolved.methods ?? false,
      target: target?.name ?? null,
      forwarded: forwarding,
      assigned: resolved.assigned ?? false,
      destructured: resolved.destructured ?? null,
    });
  return [
    ...targetsWith(found, (target) => stepOf(found, target)),
    ...(fn
      ? []
      : defaultTargets(index, binding, {
          module: data.module,
          path,
          stepOf,
        })),
  ];
};

const producedStep = (kind, extra) => ({ kind, location: null, ...extra });

/**
 * What a call an initializer makes when the module loads gives the value
 * read with `read.path` (below each element of it with `read.element`):
 * for `new`, the instance's methods (the one a member read names, else
 * each, as a guess when one is named); otherwise what the called function
 * returns. Code the call runs is not reached by reading the value.
 */
export const producedBy = (index, target, call, read = {}) => {
  const { path = null, element = false } = read;
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
      element,
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
        region: {
          ...target.region,
          ...(path ? { path, element } : {}),
        },
        step: producedStep("returns", { selects: member, how: "forward" }),
      },
    ];
  return [{ ...target, step: producedStep("returns", { how: "all" }) }];
};
