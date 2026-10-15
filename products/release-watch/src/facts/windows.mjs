// What each BrowserWindow loads. REA reports the window and each
// `loadFile`/`loadURL` call with what it loads and, when the call is made on
// a variable, its name (`call:viewer.loadFile`), but not which window the
// call loads into. Release Watch correlates them by position:
// - a call made on the constructor itself (`new BrowserWindow(…).loadURL(`)
//   starts where the window does;
// - a window held in a variable is linked to the binding declared or
//   assigned just before its constructor on the same line (`const viewer =
//   new BrowserWindow(`, `win = new BrowserWindow(`), when one binding of
//   that name exists in the module. When that variable holds several windows,
//   a call goes to the window assigned to it last before the call.
import { firstObservation } from "./provenance.mjs";
import { modulePathOf } from "./modules.mjs";

const LOAD =
  /^call:(?:(?:this\.)?([\w$]+)(?:\.webContents)?\.)?(?:loadFile|loadURL)$/;
// `const name = new BrowserWindow(` leaves at most a few characters between
// the binding's end and the constructor.
const MAX_GAP = 12;

const startOf = (node) => {
  const location = firstObservation(node)?.evidence?.location?.value;
  return location?.kind === "source-range" ? location.start : null;
};
const isBefore = (a, b) =>
  a.line < b.line || (a.line === b.line && a.column < b.column);
const samePosition = (a, b) => a.line === b.line && a.column === b.column;

// Per module, every load call REA reports: `{ variable, path, start }`, with
// a null variable for a call made on an expression.
const loadCalls = (graph) => {
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const loads = new Map();
  for (const edge of graph.edges) {
    if (edge.relation !== "loads") continue;
    const source = byId.get(edge.source_node_id);
    const target = byId.get(edge.target_node_id);
    const properties = firstObservation(target ?? {})?.properties ?? {};
    const match = LOAD.exec(properties.mechanism ?? "");
    const modulePath = source ? modulePathOf(source) : null;
    if (target?.kind !== "electron-renderer" || !match || !modulePath) continue;
    if (!loads.has(modulePath)) loads.set(modulePath, []);
    loads.get(modulePath).push({
      variable: match[1] ?? null,
      path: properties.declared_path ?? properties.candidate_path ?? "",
      start: startOf(target),
    });
  }
  return loads;
};

// Per module, the places a binding takes a value: its declaration, and every
// assignment REA reports as a write (`mainWindow = new BrowserWindow(`), each
// with the name of the binding it sets.
const placeOf = (node, binding = node) => {
  const range = node?.identity?.source_range;
  const modulePath = node?.identity?.module_path;
  return binding?.kind === "binding" && range && modulePath && binding.label
    ? { modulePath, entry: { name: binding.label, range, id: binding.node_id } }
    : null;
};

const bindingsByModule = (semantic) => {
  const nodes = semantic?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const places = [
    ...nodes.map((node) => placeOf(node)),
    ...(semantic?.relations ?? [])
      .filter((relation) => relation.relation === "writes")
      .map((relation) =>
        placeOf(
          byId.get(relation.source_node_id),
          byId.get(relation.target_node_id),
        ),
      ),
  ].filter(Boolean);
  const modules = new Map();
  for (const { modulePath, entry } of places) {
    if (!modules.has(modulePath)) modules.set(modulePath, []);
    modules.get(modulePath).push(entry);
  }
  return modules;
};

// The binding a window is assigned to, by position.
const bindingOf = (bindings, location) =>
  bindings
    .filter(
      ({ range }) =>
        range.end.line === location.line &&
        range.end.column <= location.column &&
        location.column - range.end.column <= MAX_GAP,
    )
    .sort((a, b) => b.range.end.column - a.range.end.column)[0] ?? null;

// The variable that holds a window: one binding of that name in the module,
// declared once, however often set.
const variableOf = (window, all) => {
  const binding = window.location ? bindingOf(all, window.location) : null;
  if (binding === null) return null;
  const ids = new Set(
    all
      .filter((candidate) => candidate.name === binding.name)
      .map((candidate) => candidate.id),
  );
  return ids.size === 1 ? binding.name : null;
};

// The calls on `variable` that load into `window`: all of them when the
// variable holds one window, else those after its assignment and before the
// variable's next window.
const variableLoads = (window, variable, { calls, windows }) => {
  const held = windows
    .filter((other) => other.data.variable === variable)
    .map((other) => other.location)
    .sort((a, b) => (isBefore(a, b) ? -1 : 1));
  const own = held.findIndex((location) =>
    samePosition(location, window.location),
  );
  const next = held[own + 1] ?? null;
  return calls.filter(
    (call) =>
      call.variable === variable &&
      (held.length === 1 ||
        (call.start !== null &&
          !isBefore(call.start, window.location) &&
          (next === null || isBefore(call.start, next)))),
  );
};

/**
 * Windows with `data.variable`, the binding that holds each window (null when
 * not established), and `data.loads`, what the window loads, or [].
 */
export const withLoads = (windows, graph, semantic) => {
  const loads = loadCalls(graph);
  const bindings = bindingsByModule(semantic);
  const moduleOf = (window) => window.data.source_path ?? window.location?.file;
  const held = windows.map((window) => ({
    ...window,
    data: {
      ...window.data,
      variable: variableOf(window, bindings.get(moduleOf(window)) ?? []),
    },
  }));
  return held.map((window) => {
    const calls = loads.get(moduleOf(window)) ?? [];
    const scope = {
      calls,
      windows: held.filter((other) => moduleOf(other) === moduleOf(window)),
    };
    const chained = calls.filter(
      (call) =>
        call.variable === null &&
        call.start !== null &&
        window.location &&
        samePosition(call.start, window.location),
    );
    const targets = [
      ...chained,
      ...(window.data.variable
        ? variableLoads(window, window.data.variable, scope)
        : []),
    ];
    return {
      ...window,
      data: { ...window.data, loads: targets.map((call) => call.path).sort() },
    };
  });
};
