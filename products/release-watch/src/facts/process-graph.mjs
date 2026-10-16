// The parts of one module's semantic graph that say where a child_process
// value goes: binding reads and where each flows (call arguments, the
// parameters REA links them to, return values), member reads by where they
// start, call sites with their argument ranges, REA's process sites, the
// property slots REA destructures from a binding, which binding each
// definition defines, the binding each read reads, constant and unknown
// values REA reports for bindings. Ranges and node ids only; no source is
// read.
import { startsBefore, within } from "../ranges.mjs";

const rangeOf = (node) => node?.identity?.source_range ?? null;
const moduleOf = (node) => node?.identity?.module_path ?? null;
// REA's binding nodes carry the binding's id after this role-key prefix;
// property slots name the object they belong to by that id.
const BINDING_ROLE = "binding:";
const ARGUMENT_ROLE = "argument:";
// The definition nodes REA reports for a declaration's binding and for an
// assignment to it; parameters and function declarations are defined by
// their call or body, never by a value read after them.
const VALUE_DEFINITIONS = new Set(["variable", "assignment"]);

/** True for the node REA reports for one argument of a call. */
const isArgument = (node) =>
  node?.kind === "expression" &&
  (node.identity?.role_key ?? "").startsWith(ARGUMENT_ROLE);

const isBinding = (node) =>
  node?.kind === "binding" || node?.kind === "parameter";

const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

const byStart = (a, b) => startsBefore(rangeOf(a), rangeOf(b));

const emptyModule = () => ({
  nodes: [],
  calls: [],
  arguments: [],
  memberReads: [],
  bindings: [],
});

const NODE_GROUPS = [
  [(node) => node.kind === "call-site", "calls"],
  [isBinding, "bindings"],
  [isArgument, "arguments"],
  [
    (node) =>
      node.kind === "expression" && node.properties?.operation_kind === "read",
    "memberReads",
  ],
];

const groupNodes = (semantic, wanted) => {
  const modules = new Map();
  const slots = new Map();
  for (const node of semantic.nodes) {
    const module = moduleOf(node);
    if (!wanted.has(module)) continue;
    const objectId = node.properties?.object_binding_id;
    if (node.kind === "property-slot" && objectId)
      push(slots, `${module}\u0000${objectId}`, node);
    if (!rangeOf(node)) continue;
    if (!modules.has(module)) modules.set(module, emptyModule());
    const entry = modules.get(module);
    entry.nodes.push(node);
    for (const [test, group] of NODE_GROUPS)
      if (test(node)) entry[group].push(node);
  }
  for (const entry of modules.values())
    for (const list of Object.values(entry)) list.sort(byStart);
  return { modules, slots };
};

// The ranges of the process sites REA classified in each wanted module.
const processRanges = (childProcesses, modules) => {
  for (const fact of childProcesses) {
    const entry = modules.get(fact.data.module);
    if (entry && fact.data.range) entry.processes.push(fact.data.range);
  }
};

// What REA reports about each binding's value: the reasons it gives for a
// value it could not establish (`unknown-value` unknowns name the binding).
const valueReasons = (semantic, byId, wanted) => {
  const reasons = new Map();
  for (const unknown of semantic.unknowns ?? []) {
    if (unknown.reason !== "unknown-value") continue;
    const node = byId.get(unknown.node_id);
    if (!isBinding(node) || !wanted.has(moduleOf(node))) continue;
    if (!reasons.has(node.node_id)) reasons.set(node.node_id, new Set());
    reasons.get(node.node_id).add(unknown.detail ?? "");
  }
  return reasons;
};

const emptyIndex = () => ({
  out: new Map(),
  defines: new Map(),
  readBinding: new Map(),
  aliasedFrom: new Map(),
  literals: new Map(),
  callAssigned: new Set(),
});

// One relation of a wanted module into the index.
const indexRelation = (index, relation, source, target) => {
  push(index.out, source.node_id, { ...relation, target });
  const kind = relation.relation;
  if (kind === "defines" && isBinding(target)) {
    push(index.defines, source.node_id, target);
    if (source.kind === "literal")
      index.literals.set(target.node_id, source.properties?.value);
  }
  if (kind === "reads" && isBinding(source))
    index.readBinding.set(target.node_id, source);
  if (kind === "aliases") {
    push(index.aliasedFrom, target.node_id, source);
    if (source.kind === "call-site" && isBinding(target))
      index.callAssigned.add(target.node_id);
  }
};

/**
 * The semantic index of the modules in `wanted`: per module its nodes, call
 * sites, arguments, member reads and bindings sorted by start, and the
 * ranges of its process sites (`childProcesses`, the facts projected from
 * REA's child-process nodes); property slots by module and the binding id
 * of their object (a scope id, unique only within its file); the relations
 * from nodes of those modules by source node; the bindings each definition
 * node defines; the binding each read reads; the nodes that alias into each
 * node; the constant REA reports for a binding a literal defines; the
 * bindings a call's result is assigned to; and the reasons REA gives for
 * each binding's unknown value.
 */
export const processGraph = (semantic, wanted, childProcesses) => {
  const byId = new Map(semantic.nodes.map((node) => [node.node_id, node]));
  const { modules, slots } = groupNodes(semantic, wanted);
  for (const entry of modules.values()) entry.processes = [];
  processRanges(childProcesses, modules);
  const index = emptyIndex();
  for (const relation of semantic.relations) {
    const source = byId.get(relation.source_node_id);
    const target = byId.get(relation.target_node_id);
    if (!target || !wanted.has(moduleOf(source))) continue;
    indexRelation(index, relation, source, target);
  }
  return {
    modules,
    slots,
    ...index,
    reasons: valueReasons(semantic, byId, wanted),
  };
};

/** Relations from `node` named `relation`, with their target nodes. */
export const relationsOf = (graph, node, relation) =>
  (graph.out.get(node.node_id) ?? []).filter(
    (item) => item.relation === relation,
  );

/** The id REA's property slots use for a binding node, or null. */
export const bindingIdOf = (node) => {
  const role = node.identity?.role_key ?? "";
  return role.startsWith(BINDING_ROLE) ? role.slice(BINDING_ROLE.length) : null;
};

/** Bindings REA destructures from `binding`'s value, with the property path of each. */
export const destructured = (graph, binding) =>
  (
    graph.slots.get(`${moduleOf(binding)}\u0000${bindingIdOf(binding)}`) ?? []
  ).flatMap((slot) =>
    relationsOf(graph, slot, "destructures").map(({ target }) => ({
      binding: target,
      path: slot.properties?.property_path ?? [],
    })),
  );

// In a list sorted by start, the first item that starts after `position`.
const firstAfter = (list, position) => {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (startsBefore(rangeOf(list[middle]), { start: position }) <= 0)
      low = middle + 1;
    else high = middle;
  }
  return low;
};

// In a list sorted by start, the first item that starts at or after `position`.
const firstAt = (list, position) => {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (startsBefore(rangeOf(list[middle]), { start: position }) < 0)
      low = middle + 1;
    else high = middle;
  }
  return low;
};

const sameRange = (a, b) =>
  startsBefore(a, b) === 0 &&
  a.end.line === b.end.line &&
  a.end.column === b.end.column;

const strictlyWithin = (inner, outer) =>
  within(inner, outer) && !sameRange(inner, outer);

// True when `range` lies inside one of the arguments of the call at
// `callRange`. An argument starts after its call starts, so the call that
// contains this one as an argument does not count as one of its arguments.
const inArgument = (entry, callRange, range) => {
  for (
    let index = firstAfter(entry.arguments, callRange.start);
    index < entry.arguments.length;
    index += 1
  ) {
    const argumentRange = rangeOf(entry.arguments[index]);
    if (startsBefore({ start: callRange.end }, argumentRange) < 0) break;
    if (within(argumentRange, callRange) && within(range, argumentRange))
      return true;
  }
  return false;
};

// True when a node REA reports inside the call at `callRange` contains
// `range`: a function whose body holds it (an IIFE), a member read of which
// it is the object or a computed key, a call it is part of.
const wrapped = (entry, callRange, range) => {
  for (
    let index = firstAt(entry.nodes, callRange.start);
    index < entry.nodes.length;
    index += 1
  ) {
    const nodeRange = rangeOf(entry.nodes[index]);
    if (startsBefore(nodeRange, range) > 0) break;
    if (
      strictlyWithin(range, nodeRange) &&
      strictlyWithin(nodeRange, callRange)
    )
      return true;
  }
  return false;
};

/**
 * True when `range` is what the call at `callRange` calls: inside the call,
 * outside every argument of it, and no node REA reports inside the call
 * contains it. A read inside an IIFE's body or in a computed key of the
 * callee is part of the call but is not what it calls.
 */
const isCallee = (entry, callRange, range) =>
  strictlyWithin(range, callRange) &&
  !inArgument(entry, callRange, range) &&
  !wrapped(entry, callRange, range);

/** The call site that calls `range`, or null. */
export const callOf = (entry, range) =>
  entry.calls.find((call) => isCallee(entry, rangeOf(call), range)) ?? null;

/** The process site REA classified that calls `range`, or null. */
export const processOf = (entry, range) =>
  entry.processes.find((site) => isCallee(entry, site, range)) ?? null;

/**
 * What the call `call` calls: the largest node that starts where the call
 * starts and lies inside it, outside its arguments (`load` of
 * `load("x")`, `module.require` of `module.require("x")`, the inner call
 * of `eval("require")("x")`). Null when REA reports none.
 */
export const calleeOf = (entry, call) => {
  const callRange = rangeOf(call);
  let found = null;
  for (
    let index = firstAt(entry.nodes, callRange.start);
    index < entry.nodes.length;
    index += 1
  ) {
    const node = entry.nodes[index];
    const nodeRange = rangeOf(node);
    if (startsBefore(nodeRange, callRange) > 0) break;
    if (
      !isArgument(node) &&
      strictlyWithin(nodeRange, callRange) &&
      !inArgument(entry, callRange, nodeRange) &&
      (found === null || strictlyWithin(rangeOf(found), nodeRange))
    )
      found = node;
  }
  return found;
};

/**
 * The innermost member read that starts where `range` starts and contains
 * it: the read of which `range` is the object (`cp.exec`, `cp[name]`).
 */
export const memberReadAt = (entry, range) => {
  let found = null;
  for (const read of entry.memberReads) {
    const readRange = rangeOf(read);
    const order = startsBefore(readRange, range);
    if (order > 0) break;
    if (
      order === 0 &&
      strictlyWithin(range, readRange) &&
      (found === null || within(readRange, rangeOf(found)))
    )
      found = read;
  }
  return found;
};

// True when REA's facts allow `binding` to hold the value read at a
// definedBefore range: REA reports its value as unknown and assigns it no
// call's result, and, for a read of a binding's own value (`reasons`), it
// gives the same reasons for both values, as it does for `const proc = cp`
// (its value is cp's) and not for `const ready = typeof cp === "object"`.
const mayHold = (graph, binding, reasons) => {
  if (binding.kind !== "binding" || graph.callAssigned.has(binding.node_id))
    return false;
  const own = graph.reasons.get(binding.node_id);
  if (!own) return false;
  return reasons === null || [...own].every((reason) => reasons.has(reason));
};

/**
 * The bindings a declaration or assignment right before `range` defines:
 * REA reports no node between that definition's end and the start of
 * `range`, as for `const proc = cp` or `x = cp`, and REA's value facts
 * allow it (`mayHold`). `reasons` are the reasons REA gives for the read
 * value when it is a binding's own value, null for a member of one.
 * Release Watch's correlation: REA does not link an initializer to its
 * binding.
 */
export const definedBefore = (graph, entry, range, reasons) => {
  let last = null;
  for (const node of entry.nodes) {
    if (startsBefore(rangeOf(node), range) >= 0) break;
    if (!within(range, rangeOf(node))) last = rangeOf(node).start;
  }
  if (last === null) return [];
  return entry.nodes
    .filter(
      (node) =>
        VALUE_DEFINITIONS.has(node.label) &&
        startsBefore({ start: last }, rangeOf(node)) === 0 &&
        startsBefore({ start: rangeOf(node).end }, range) <= 0,
    )
    .flatMap((node) => graph.defines.get(node.node_id) ?? [])
    .filter((binding) => mayHold(graph, binding, reasons));
};

const isDestructure = (node) =>
  node.kind === "expression" &&
  node.properties?.operation_kind === "destructure";

/**
 * The bindings a destructuring declaration right before `range` takes from
 * it, with the property path of each, for a value REA links to no binding
 * (`const { exec } = window.require("child_process")`): the run of
 * destructure reads, their bindings and definitions that ends where
 * `range` starts, with no other node between. Release Watch's correlation:
 * REA reports the pattern but does not link it to its initializer.
 */
export const destructuredBefore = (graph, entry, range) => {
  const found = [];
  for (
    let index = firstAt(entry.nodes, range.start) - 1;
    index >= 0;
    index -= 1
  ) {
    const node = entry.nodes[index];
    if (startsBefore({ start: rangeOf(node).end }, range) > 0) break;
    if (isDestructure(node)) found.push(node);
    else if (!isBinding(node) && !VALUE_DEFINITIONS.has(node.label)) break;
  }
  return found.flatMap((read) =>
    entry.bindings
      .filter(
        (binding) =>
          binding.kind === "binding" &&
          sameRange(rangeOf(binding), rangeOf(read)),
      )
      .map((binding) => ({
        binding,
        path: read.properties?.property_path ?? [],
      })),
  );
};

export { rangeOf, moduleOf, sameRange, isArgument };
