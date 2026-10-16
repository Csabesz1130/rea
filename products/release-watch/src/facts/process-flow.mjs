// Follows the values a module's seeds tie to child_process (process-sources)
// to each place they are read, and keeps the uses that no process site REA
// classified accounts for: a call REA did not classify, a member read, a
// value passed to a call REA did not resolve, returned, or used where REA's
// graph does not show where it goes, or a load REA ties to no binding.
import { isProcessExport } from "../catalog.mjs";
import { within } from "../ranges.mjs";
import {
  callOf,
  definedBefore,
  destructured,
  destructuredBefore,
  isArgument,
  memberReadAt,
  processOf,
  rangeOf,
  relationsOf,
  sameRange,
} from "./process-graph.mjs";

// A holder from a load Release Watch only takes to be child_process counts
// through a child_process export it names, never through another member.
const loaderMember = (holder, member) =>
  !holder.loader || holder.member !== null || isProcessExport(member);

const addCarrier = (state, node, holder) => {
  if (state.carriers.has(node.node_id)) return;
  if (
    holder.loader &&
    holder.member !== null &&
    !isProcessExport(holder.member)
  )
    return;
  const carrier = { ...holder, node, name: node.label ?? null };
  state.carriers.set(node.node_id, carrier);
  state.queue.push(carrier);
};

const addUse = (state, use) => {
  const member = use.holder.member ?? use.path?.[0] ?? null;
  if (use.holder.loader && !isProcessExport(member)) return;
  state.uses.push(use);
};

// Bindings a call's result is assigned to, as REA links them.
const assignedFrom = (state, call) =>
  relationsOf(state.graph, call, "aliases")
    .map(({ target }) => target)
    .filter((node) => node.kind === "binding");

// The holder for one member of a namespace (`proc.execSync` of `import * as
// proc`), with the rest of the path; null for a name that holds none.
const throughNamespace = (holder, path) => {
  if (!holder.namespace) return { holder, path };
  const name = path?.[0];
  const inner =
    name === undefined
      ? null
      : (holder.namespace.names.get(name) ??
        (holder.namespace.star ? { member: name } : null));
  if (!inner) return null;
  return {
    holder: {
      ...holder,
      node: undefined,
      name: `${holder.name}.${name}`,
      member: inner.member,
      namespace: inner.namespace ?? null,
      via: inner.heuristic ? "export-name" : holder.via,
      exported: name,
      heuristic: holder.heuristic || inner.heuristic === true,
    },
    path: path.length > 1 ? path.slice(1) : null,
  };
};

// Derives the holder of a value read from `holder` along `path`.
const derived = (holder, path, extra) => ({
  member: path === null ? holder.member : (holder.member ?? path[0]),
  namespace: path === null ? (holder.namespace ?? null) : null,
  from: path === null ? holder.name : `${holder.name}.${path.join(".")}`,
  heuristic: holder.heuristic,
  loader: holder.loader,
  ...extra,
});

// The parameters REA links the arguments `node` is passed as to.
const parametersOf = (graph, passed) =>
  passed.flatMap(({ target }) =>
    relationsOf(graph, target, "argument-to-parameter").map(
      (relation) => relation.target,
    ),
  );

/**
 * Where a value that holds child_process (or one of its exports) goes from
 * `node`: a call REA did not classify, a parameter REA links it to, an
 * unresolved call it is passed to, a return value, the binding a
 * definition right before it defines, or somewhere REA's graph does not
 * show. `path` is the member read's property path, null for the value
 * itself.
 */
const flowUse = (state, node, holder, path = null) => {
  const { graph, index } = state;
  const range = rangeOf(node);
  const use = { node, holder, path };
  if (callOf(index, range)) return addUse(state, { ...use, kind: "call" });
  const aliases = relationsOf(graph, node, "aliases");
  const passed = aliases.filter(({ target }) => isArgument(target));
  const parameters = parametersOf(graph, passed);
  for (const parameter of parameters)
    addCarrier(state, parameter, {
      ...derived(holder, path),
      via: "parameter",
    });
  if (parameters.length > 0) return undefined;
  if (passed.length > 0) return addUse(state, { ...use, kind: "pass" });
  const returned = aliases.some(
    ({ target, resolution }) =>
      target.kind === "return-site" && resolution === "resolved",
  );
  if (returned) return addUse(state, { ...use, kind: "return" });
  // A binding's own value is compared by the reasons REA gives for it.
  const reasons =
    path === null && holder.node
      ? (graph.reasons.get(holder.node.node_id) ?? new Set())
      : null;
  const bindings = definedBefore(graph, index, range, reasons);
  for (const binding of bindings)
    addCarrier(state, binding, {
      ...derived(holder, path),
      via: "alias",
      heuristic: true,
    });
  if (bindings.length > 0) return undefined;
  return addUse(state, { ...use, kind: path === null ? "value" : "read" });
};

// A member read on a value that holds child_process: classified when REA
// reported a process site that calls it; a computed name is never followed
// further.
const memberUse = (state, read, holder) => {
  const range = rangeOf(read);
  if (processOf(state.index, range)) return;
  const path = read.properties?.property_path ?? null;
  if (path === null) {
    addUse(state, {
      node: read,
      holder,
      path: null,
      kind: callOf(state.index, range) ? "computed-call" : "computed-read",
    });
    return;
  }
  const resolved = throughNamespace(holder, path);
  if (!resolved || !loaderMember(resolved.holder, resolved.path?.[0])) return;
  flowUse(state, read, resolved.holder, resolved.path);
};

const followCarrier = (state, carrier) => {
  for (const { binding, path } of destructured(state.graph, carrier.node)) {
    const resolved = throughNamespace(carrier, path);
    if (resolved)
      addCarrier(state, binding, {
        ...derived(resolved.holder, resolved.path),
        via: "destructure",
        from: carrier.name,
      });
  }
  for (const { target: read } of relationsOf(
    state.graph,
    carrier.node,
    "reads",
  )) {
    const range = rangeOf(read);
    if (!range || processOf(state.index, range)) continue;
    const member = memberReadAt(state.index, range);
    if (member) memberUse(state, member, carrier);
    else flowUse(state, read, carrier);
  }
};

// The innermost call that takes exactly `range` as one of its arguments.
const wrapperOf = (index, range) => {
  const argument = index.arguments.find((node) =>
    sameRange(rangeOf(node), range),
  );
  if (!argument) return null;
  return (
    index.calls
      .filter(
        (call) =>
          within(range, rangeOf(call)) && !sameRange(range, rangeOf(call)),
      )
      .at(-1) ?? null
  );
};

const bindAll = (state, bindings, holder) => {
  for (const binding of bindings) addCarrier(state, binding, holder);
  return bindings.length > 0;
};

// A call whose result holds child_process (`require("child_process")`, a
// load of a local module that exports it): a member read on it, the
// binding it is assigned to, the binding a call wrapping it is assigned to
// (an interop helper such as `__importStar`, Release Watch's correlation),
// or a load Release Watch cannot follow.
const valueSite = (state, seed) => {
  const { index } = state;
  const range = seed.call ? rangeOf(seed.call) : seed.site.data.range;
  const { holder } = seed;
  const read = range && memberReadAt(index, range);
  if (read) return memberUse(state, read, holder);
  const call =
    seed.call ??
    (range && index.calls.find((node) => sameRange(rangeOf(node), range)));
  const assigned = { ...derived(holder, null), via: "assigned" };
  if (bindAll(state, call ? assignedFrom(state, call) : [], assigned))
    return undefined;
  const wrapper = range && wrapperOf(index, range);
  const wrapped = { ...assigned, via: "wrapper", heuristic: true };
  if (bindAll(state, wrapper ? assignedFrom(state, wrapper) : [], wrapped))
    return undefined;
  const pattern = range ? destructuredBefore(state.graph, index, range) : [];
  for (const { binding, path } of pattern)
    addCarrier(state, binding, {
      ...derived(holder, path),
      via: "pattern",
      from: holder.name,
      heuristic: true,
    });
  if (pattern.length > 0) return undefined;
  return addUse(state, {
    node: null,
    site: seed.site,
    holder,
    path: null,
    kind: "load",
  });
};

/**
 * The uses of one module's child_process values that REA classified no
 * process call for. `seeds` are the module's seeds (process-sources);
 * `importBinding` finds the binding an import edge creates.
 */
export const moduleUses = (graph, index, seeds, importBinding) => {
  const state = { graph, index, carriers: new Map(), queue: [], uses: [] };
  for (const seed of seeds) {
    if (!seed.binding) {
      valueSite(state, seed);
      continue;
    }
    const binding = importBinding(index, seed.site);
    if (binding) addCarrier(state, binding, seed.holder);
    else
      addUse(state, {
        node: null,
        site: seed.site,
        holder: seed.holder,
        path: null,
        kind: "load",
      });
  }
  while (state.queue.length > 0) followCarrier(state, state.queue.shift());
  return { uses: state.uses, carriers: state.carriers };
};
