// What holds each BrowserWindow, which functions create it and what it
// loads. REA reports the window, each `loadFile`/`loadURL` call with what it
// loads, and in its semantic graph the bindings, reads and writes around
// them, but not which window a call loads into. Release Watch links them:
// - a call made on the constructor itself (`new BrowserWindow(…).loadURL(`)
//   starts where the window does;
// - a window REA aliases to a binding (`const viewer = new BrowserWindow(`,
//   `win = new BrowserWindow(`) is held by that binding, by REA's node id, so
//   same-named locals of different functions stay apart;
// - a window assigned to a member (`windows.main = new BrowserWindow(`) is
//   held by the write REA reports just before its constructor on the same
//   line, when a later call's mechanism names the same receiver;
// - a call goes to the window its receiver holds. When the receiver holds
//   several windows, or a member of an object REA did not resolve (`this`),
//   a call goes to the window created last before it in the same function;
//   a call in another function leaves those windows' loads unknown.
import { within } from "../ranges.mjs";
import { modulePathOf } from "./modules.mjs";
import { firstObservation } from "./provenance.mjs";

const LOAD = /^call:(?:(.+?)(?:\.webContents)?\.)?(?:loadFile|loadURL)$/;
const LOAD_MEMBERS = new Set(["loadFile", "loadURL"]);
// `windows.main = new BrowserWindow(` leaves at most a few characters
// between the write's end and the constructor.
const MAX_GAP = 12;

const rangeOf = (node) => node?.identity?.source_range ?? null;
const moduleOf = (node) => node?.identity?.module_path ?? null;
const at = (modulePath, position) =>
  `${modulePath}\u0000${position.line}:${position.column}`;
const isBefore = (a, b) =>
  a.line < b.line || (a.line === b.line && a.column < b.column);
const point = (position) => ({ start: position, end: position });

const startOf = (evidence) => {
  const location = evidence?.location?.value;
  return location?.kind === "source-range" ? location.start : null;
};

// Per module, every load call REA reports: `{ receiver, path, start }`, with
// a null receiver for a call made on an expression.
const loadCalls = (graph) => {
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const calls = [];
  for (const edge of graph.edges) {
    if (edge.relation !== "loads") continue;
    const source = byId.get(edge.source_node_id);
    const target = byId.get(edge.target_node_id);
    const observation = firstObservation(target ?? {});
    const properties = observation?.properties ?? {};
    const match = LOAD.exec(
      edge.properties?.mechanism ?? properties.mechanism ?? "",
    );
    const modulePath = source ? modulePathOf(source) : null;
    const start = startOf(edge.evidence) ?? startOf(observation?.evidence);
    if (target?.kind !== "electron-renderer" || !match || !modulePath) continue;
    calls.push({
      module: modulePath,
      receiver: match[1]?.replace(/^this\./, "") ?? null,
      path: properties.declared_path ?? properties.candidate_path ?? "",
      start,
    });
  }
  return calls;
};

// Constructor call sites by position, member writes, and member reads that
// end in a load call (`windows.main.loadURL`) by position.
const nodeIndex = (nodes, index) => {
  for (const node of nodes) {
    const range = rangeOf(node);
    const modulePath = moduleOf(node);
    if (!range || !modulePath) continue;
    if (node.kind === "call-site" && node.label === "construct")
      index.constructs.set(at(modulePath, range.start), node);
    const operation = node.properties?.operation_kind;
    const path = node.properties?.property_path;
    if (node.kind !== "expression" || !Array.isArray(path)) continue;
    if (operation === "write") index.writes.push(node);
    if (operation === "read" && LOAD_MEMBERS.has(path.at(-1)))
      index.members.set(at(modulePath, range.start), node);
  }
};

// Where REA's semantic graph reads a binding, aliases a constructed value to
// one, reads or writes a member: the facts a window's holder is built from.
const semanticIndex = (semantic) => {
  const nodes = semantic?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const index = {
    constructs: new Map(),
    aliases: new Map(),
    reads: new Map(),
    members: new Map(),
    writes: [],
  };
  nodeIndex(nodes, index);
  for (const relation of semantic?.relations ?? []) {
    const source = byId.get(relation.source_node_id);
    const target = byId.get(relation.target_node_id);
    if (relation.relation === "aliases" && target?.kind === "binding") {
      const list = index.aliases.get(relation.source_node_id) ?? [];
      index.aliases.set(relation.source_node_id, [...list, target]);
    }
    const range = rangeOf(target);
    if (relation.relation === "reads" && source?.kind === "binding" && range)
      index.reads.set(at(moduleOf(target), range.start), {
        binding: source,
        expression: target,
      });
  }
  return index;
};

const memberHolder = (index, modulePath, write) => {
  const root = index.reads.get(at(modulePath, rangeOf(write).start)) ?? null;
  const path = write.properties.property_path;
  return {
    key: `member:${root?.binding.node_id ?? "?"}:${JSON.stringify(path)}`,
    name: [root?.binding.label ?? "?", ...path].join("."),
    // A member of an object REA did not resolve (`this.win`) may belong to
    // another object in another function.
    scoped: root === null,
  };
};

// What holds a window: the binding REA aliases its constructor to, else the
// member REA reports written just before it on the same line.
const holderOf = (index, modulePath, start, construct) => {
  const aliased = construct ? (index.aliases.get(construct.node_id) ?? []) : [];
  if (aliased.length === 1) {
    const [binding] = aliased;
    return { key: `binding:${binding.node_id}`, name: binding.label };
  }
  if (aliased.length > 1) return null;
  const write = index.writes
    .filter((node) => {
      const end = rangeOf(node).end;
      return (
        moduleOf(node) === modulePath &&
        end.line === start.line &&
        end.column <= start.column &&
        start.column - end.column <= MAX_GAP
      );
    })
    .sort((a, b) => rangeOf(b).end.column - rangeOf(a).end.column)[0];
  return write ? memberHolder(index, modulePath, write) : null;
};

// The receiver of a load call, by REA's reads: the binding read where the
// call starts, and the member path below it (`windows.main`), without
// `webContents`. Null when REA's facts do not name the call's own receiver.
const receiverOf = (index, call) => {
  const root = index.reads.get(at(call.module, call.start)) ?? null;
  const member = index.members.get(at(call.module, call.start)) ?? null;
  const path = (member?.properties.property_path ?? []).slice(0, -1);
  if (path.at(-1) === "webContents") path.pop();
  const text = [...(root ? [root.binding.label] : []), ...path].join(".");
  if (text === "" || text !== call.receiver) return null;
  return {
    key:
      path.length === 0
        ? `binding:${root.binding.node_id}`
        : `member:${root?.binding.node_id ?? "?"}:${JSON.stringify(path)}`,
    owner: (member ?? root.expression).function_node_id ?? null,
  };
};

// The names of the functions REA reports around a position, outermost first.
const scopeOf = (functions, modulePath, start) =>
  functions
    .filter(
      (fn) =>
        fn.module === modulePath && fn.name && within(point(start), fn.range),
    )
    .sort((a, b) =>
      isBefore(a.range.start, b.range.start)
        ? -1
        : isBefore(b.range.start, a.range.start)
          ? 1
          : 0,
    )
    .map((fn) => fn.name)
    .join(".");

// Gives each receiver's call to a window; `unknown` collects holders whose
// calls could not all be given.
const attribute = (held, receivers) => {
  const byHolder = new Map();
  for (const window of held)
    if (window.holder)
      byHolder.set(window.holder.key, [
        ...(byHolder.get(window.holder.key) ?? []),
        window,
      ]);
  const unknown = new Set();
  for (const { call, receiver } of receivers) {
    const windows = byHolder.get(receiver.key) ?? [];
    if (windows.length === 0) continue;
    const [only] = windows;
    const target =
      windows.length === 1 && !only.holder.scoped
        ? only
        : windows
            .filter(
              (window) =>
                window.owner !== undefined &&
                window.owner === receiver.owner &&
                isBefore(window.start, call.start),
            )
            .sort((a, b) => (isBefore(a.start, b.start) ? 1 : -1))[0];
    if (target) target.calls.push(call);
    else unknown.add(receiver.key);
  }
  return unknown;
};

/**
 * Windows with `data.holder` (what holds the window, null when not
 * established), `data.scope` (the named functions that create it, "" when
 * none) and `data.loads` (what the window loads, null when not established).
 */
export const withLoads = (windows, graph, semantic, functions = []) => {
  const index = semanticIndex(semantic);
  const calls = loadCalls(graph);
  const held = windows.map((window) => {
    const modulePath = window.data.source_path ?? window.location?.file;
    const start =
      window.location?.line == null
        ? null
        : { line: window.location.line, column: window.location.column };
    const construct = start
      ? (index.constructs.get(at(modulePath, start)) ?? null)
      : null;
    return {
      window,
      modulePath,
      start,
      // undefined when REA reports no constructor: the function is unknown.
      owner: construct ? (construct.function_node_id ?? null) : undefined,
      holder: start ? holderOf(index, modulePath, start, construct) : null,
      scope: start ? scopeOf(functions, modulePath, start) : "",
      calls: [],
    };
  });
  const receivers = calls.flatMap((call) => {
    if (call.start === null) return [];
    if (call.receiver === null) {
      const chained = held.find(
        (window) =>
          window.start &&
          window.modulePath === call.module &&
          !isBefore(window.start, call.start) &&
          !isBefore(call.start, window.start),
      );
      chained?.calls.push(call);
      return [];
    }
    const receiver = receiverOf(index, call);
    return receiver ? [{ call, receiver }] : [];
  });
  const unknown = attribute(held, receivers);
  return held.map(({ window, holder, scope, calls: own }) => ({
    ...window,
    data: {
      ...window.data,
      holder: holder?.name ?? null,
      scope,
      loads:
        holder && unknown.has(holder.key)
          ? null
          : own.map((call) => call.path).sort(),
    },
  }));
};
