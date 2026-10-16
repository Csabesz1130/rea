// Where a binding's value lies, as far as REA's facts place it. The value
// comes from each site REA reports giving it one: the declaration, each
// assignment, each property write (`handlers.git = …`), and, as Release
// Watch's reading of the built-in methods, the arguments of each call that
// adds to it (`TOOLS.push(…)`, `handlers.set(…)`). A call REA says the
// binding holds the result of (`aliases`) is that site's value. REA does not
// report where an object or array literal ends, except as the range of an
// `export const` statement, so Release Watch ends any other site's value at
// the first statement of the site's own scope it can place after it: the
// next declaration, the binding's next use or site, an event listener
// registration, a timer or a promise a statement discards, within the
// site's own function. Functions nested in the value, and their bindings
// (a named function or class expression's own name too), are part of it,
// not statements after it.
import { startsBefore, within } from "../ranges.mjs";
import { ADDERS } from "./reach-builtins.mjs";
import {
  WHOLE_MODULE,
  bindingAt,
  enclosingFunction,
  firstStarting,
  memberAt,
  namedFunctions,
  readsOfBinding,
  scopeOf,
  writeAt,
} from "./reach-index.mjs";

// `const name = (` or `const name = async function (`: the gap between a
// binding and the function it is assigned.
const MAX_GAP = 40;

const comesBefore = (a, b) => startsBefore({ start: a }, { start: b }) < 0;

// The function a binding is declared as: REA gives a declaration's binding
// the declared function (or class) as owner.
const declaration = (index, binding) => {
  const declared = index.byId.get(binding.owner);
  return declared?.name === binding.name &&
    within(binding.range, declared.range)
    ? declared
    : null;
};

/**
 * The function a binding's declaration or initializer is: a declaration,
 * or a function assigned to it, which starts just after the binding in the
 * binding's scope. A binding REA reports later assignments or property
 * writes to is a value, since each can give it another function.
 */
export const declaredFunction = (index, module, binding) => {
  const declared = declaration(index, binding);
  if (declared) return declared;
  if (sitesOf(index, module, binding).length > 1) return null;
  const bindings = index.bindings.get(module) ?? [];
  const following =
    bindings[
      firstStarting(bindings, { start: binding.range.end }, { after: true })
    ];
  // Another binding between the two: the function is assigned to that one.
  const between = (fn) =>
    following !== undefined && startsBefore(following.range, fn.range) < 0;
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

// Where a binding's statement starts and the scope it belongs to: a
// declaration's binding sits after `function` or `class`, inside the
// declared function, so the statement is that function's. A function or
// class expression's own name is no statement of the scope around it.
const statementOf = (index, binding) => {
  const declared = binding.ownName ? null : declaration(index, binding);
  return declared
    ? { start: declared.range.start, scope: scopeOf(index, declared) }
    : { start: binding.range.start, scope: binding.owner ?? null };
};

// The outermost call of `scope` around `range` that starts after `after`:
// as far as REA's call sites show, where the statement holding it starts.
const callAround = (index, module, { range, scope, after }) => {
  const calls = index.callSites.get(module) ?? [];
  for (let next = firstStarting(calls, after); next < calls.length; next += 1) {
    const call = calls[next];
    if (startsBefore(range, call.range) < 0) break;
    if (call.owner === scope && within(range, call.range))
      return call.range.start;
  }
  return null;
};

// The places REA reports giving a binding a value, in source order, each
// with the scope its statement belongs to and, for a property write, the
// member it writes: the declaration, each assignment, and each property
// write on a read of the binding. Built once per binding.
const sitesOf = (index, module, binding) => {
  const key = `${module}\u0000${JSON.stringify(binding.range.start)}`;
  if (index.sites.has(key)) return index.sites.get(key);
  const later = (range, member = null) => ({
    range,
    member,
    later: true,
    scope: enclosingFunction(index, module, range)?.id ?? null,
  });
  const record = bindingAt(index, module, binding.range);
  const writes = readsOfBinding(index, module, binding.range).flatMap(
    ({ range }) => {
      const write = writeAt(index, module, range);
      return write ? [later(write.range, write.path[0] ?? null)] : [];
    },
  );
  const sites = [
    {
      range: binding.range,
      member: null,
      later: false,
      scope: statementOf(index, binding).scope,
    },
    ...(record?.assignments ?? []).map((range) => later(range)),
    ...writes,
  ].sort((a, b) => startsBefore(a.range, b.range));
  index.sites.set(key, sites);
  return sites;
};

// A declaration cannot read its binding outside a function it defines, so
// it ends before the first statement of its scope that does. A later site
// can read the binding in its own value (`tools = [...tools, extra]`), so
// only a use inside a call of its scope, a later statement, ends it.
const firstUse = ({ index, module, binding }, site, scope) => {
  const after = { start: site.range.end };
  for (const { range } of readsOfBinding(index, module, binding.range)) {
    if (!comesBefore(range.start, scope.end)) return null;
    if (
      !comesBefore(site.range.start, range.start) ||
      (enclosingFunction(index, module, range)?.id ?? null) !== scope.id
    )
      continue;
    const call = callAround(index, module, { range, scope: scope.id, after });
    if (call || !site.later) return call ?? range.start;
  }
  return null;
};

// The next declaration in the site's own scope: bindings of functions
// nested in the value belong to those functions and do not end it.
const nextDeclaration = ({ index, module }, site, scope) => {
  const bindings = index.bindings.get(module) ?? [];
  for (
    let next = firstStarting(bindings, site.range, { after: true });
    next < bindings.length;
    next += 1
  ) {
    if (!comesBefore(bindings[next].range.start, scope.end)) return null;
    const statement = statementOf(index, bindings[next]);
    if (
      statement.scope === scope.id &&
      comesBefore(site.range.start, statement.start)
    )
      return statement.start;
  }
  return null;
};

// The first item of a module's `list` after the site that `inScope`
// places in the site's scope, or null.
const firstIn = (list = [], site, { scope, inScope }) => {
  for (
    let next = firstStarting(list, { start: site.range.end });
    next < list.length;
    next += 1
  ) {
    if (!comesBefore(list[next].range.start, scope.end)) return null;
    if (inScope(list[next])) return list[next];
  }
  return null;
};

// The first statement REA recognises in the site's scope: an event
// listener registration, a timer, or a promise a statement discards.
const firstMarker = ({ index, module }, site, scope) => {
  const marker = firstIn(index.markers.get(module), site, {
    scope,
    inScope: (candidate) => candidate.owner === scope.id,
  });
  if (!marker) return null;
  const after = { start: site.range.end };
  return (
    callAround(index, module, {
      range: marker.range,
      scope: scope.id,
      after,
    }) ?? marker.range.start
  );
};

// The first assignment or property write REA reports in the site's scope,
// of any binding: a statement of its own (this binding's next site too).
const firstWrite = ({ index, module }, site, scope) => {
  const inScope = (candidate) =>
    (enclosingFunction(index, module, candidate.range)?.id ?? null) ===
    scope.id;
  const found = [index.writes, index.assignments]
    .map((lists) => firstIn(lists.get(module), site, { scope, inScope }))
    .filter(Boolean)
    .map((item) => item.range.start);
  return found.sort((a, b) => startsBefore({ start: a }, { start: b }))[0];
};

// The end of the `export const` statement REA reports declaring the
// binding: exactly where its initializer ends. Export statements do not
// nest, so it is the last one starting before the binding.
const exportedEnd = ({ index, module }, site) => {
  if (site.later) return null;
  const statements = index.exports.get(module) ?? [];
  const statement = statements[firstStarting(statements, site.range) - 1];
  return statement && within(site.range, statement.range)
    ? statement.range.end
    : null;
};

// Where the value a site gives ends: the end of the export statement that
// declares it (`exact`), else the first statement of its scope Release
// Watch can place after it.
const siteEnd = (context, site) => {
  const owner = site.scope === null ? null : context.index.byId.get(site.scope);
  const scope = { id: site.scope, end: owner?.range.end ?? WHOLE_MODULE.end };
  const exported = exportedEnd(context, site);
  let { end } = scope;
  for (const cut of [
    exported,
    firstUse(context, site, scope),
    nextDeclaration(context, site, scope),
    firstMarker(context, site, scope),
    firstWrite(context, site, scope),
  ])
    if (cut && comesBefore(cut, end)) end = cut;
  return { end, exact: exported !== null };
};

// The call that starts at `range` with `member` as its callee: the
// innermost call starting there that runs past the member read.
const callOf = (index, module, { range, member }) => {
  const calls = index.callSites.get(module) ?? [];
  let found = null;
  for (
    let next = firstStarting(calls, range);
    next < calls.length && startsBefore(calls[next].range, range) === 0;
    next += 1
  ) {
    const { end } = calls[next].range;
    if (
      comesBefore(member.range.end, end) &&
      (!found || comesBefore(end, found.range.end))
    )
      found = calls[next];
  }
  return found;
};

// The arguments of each call that adds to the binding's value: a call
// whose callee is a member read of an adding method on a read of the
// binding (`TOOLS.push(…)`).
const addedBy = ({ index, module, binding }) =>
  readsOfBinding(index, module, binding.range).flatMap(({ range }) => {
    const member = memberAt(index, module, range);
    if (member?.path.length !== 1 || !ADDERS.has(member.path[0])) return [];
    const call = callOf(index, module, { range, member });
    return call ? [{ start: member.range.end, end: call.range.end }] : [];
  });

/** Ranges sorted by start, overlapping ones merged. */
export const disjoint = (parts) => {
  const merged = [];
  for (const part of [...parts].sort(startsBefore)) {
    const last = merged.at(-1);
    if (!last || !comesBefore(part.start, last.end)) merged.push(part);
    else if (comesBefore(last.end, part.end))
      merged[merged.length - 1] = { start: last.start, end: part.end };
  }
  return merged;
};

// Each site's value, after the binding or target: the calls REA says the
// binding holds the result of that lie in it, else the source up to where
// it ends, `open` when Release Watch placed that end.
const regionOf = (index, module, binding) => {
  const sites = sitesOf(index, module, binding);
  const calls = bindingAt(index, module, binding.range)?.initializers ?? [];
  const context = { index, module, binding };
  const members = new Map();
  const unwritten = [];
  const open = [];
  for (const site of sites) {
    const { end, exact } = siteEnd(context, site);
    const part = { start: site.range.end, end };
    const held = calls.filter((call) => within(call, part));
    const value = held.length > 0 ? held : [part];
    if (held.length === 0 && !exact) open.push(part);
    if (site.member === null) unwritten.push(...value);
    else
      members.set(site.member, [...(members.get(site.member) ?? []), ...value]);
  }
  const written = [...members.values()].flat();
  // A call REA ties to the binding outside every site still gives it a value.
  for (const call of calls)
    if (![...unwritten, ...written].some((part) => within(call, part)))
      unwritten.push(call);
  const added = addedBy(context);
  unwritten.push(...added);
  for (const [member, parts] of members) members.set(member, disjoint(parts));
  return {
    parts: disjoint([...unwritten, ...written]),
    unwritten: disjoint(unwritten),
    members,
    open: disjoint(open),
    extended: sites.length > 1 || added.length > 0,
  };
};

/**
 * Where a value binding's value lies, built once per binding: `{ parts,
 * unwritten, members, open, extended }`, the disjoint ranges of every site,
 * of those that write no one member, of each member REA reports written, of
 * those whose end Release Watch placed, and whether anything after the
 * declaration gives it a value.
 */
export const valueRegion = (index, module, binding) => {
  const key = `${module}\u0000${JSON.stringify(binding.range.start)}`;
  if (!index.regions.has(key))
    index.regions.set(key, regionOf(index, module, binding));
  return index.regions.get(key);
};
