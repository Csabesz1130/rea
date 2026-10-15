// What each BrowserWindow loads. REA reports the window, the variable a
// `loadFile`/`loadURL` call is made on (`call:viewer.loadFile`) and what it
// loads, but not which window that variable holds. Release Watch links a
// window to the binding declared just before its constructor on the same
// line (`const viewer = new BrowserWindow(`), when that binding's name is
// unique in the module. The link is Release Watch's correlation.
import { firstObservation } from "./provenance.mjs";
import { modulePathOf } from "./modules.mjs";

const LOAD =
  /^call:(?:this\.)?([\w$]+)(?:\.webContents)?\.(?:loadFile|loadURL)$/;
// `const name = new BrowserWindow(` leaves at most a few characters between
// the binding's end and the constructor.
const MAX_GAP = 12;

// `Map(module → Map(variable → [declared paths]))` from REA's loads edges.
const loadsByVariable = (graph) => {
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const loads = new Map();
  for (const edge of graph.edges) {
    if (edge.relation !== "loads") continue;
    const source = byId.get(edge.source_node_id);
    const target = byId.get(edge.target_node_id);
    const properties = firstObservation(target ?? {})?.properties ?? {};
    const variable = LOAD.exec(properties.mechanism ?? "")?.[1];
    const modulePath = source ? modulePathOf(source) : null;
    if (target?.kind !== "electron-renderer" || !variable || !modulePath)
      continue;
    if (!loads.has(modulePath)) loads.set(modulePath, new Map());
    const byName = loads.get(modulePath);
    byName.set(variable, [
      ...(byName.get(variable) ?? []),
      properties.declared_path ?? properties.candidate_path ?? "",
    ]);
  }
  return loads;
};

const bindingsByModule = (semantic) => {
  const modules = new Map();
  for (const node of semantic?.nodes ?? []) {
    const range = node.identity?.source_range;
    const modulePath = node.identity?.module_path;
    if (node.kind !== "binding" || !range || !modulePath || !node.label)
      continue;
    if (!modules.has(modulePath)) modules.set(modulePath, []);
    modules.get(modulePath).push({ name: node.label, range });
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

/**
 * Windows with `data.variable`, the binding that holds each window (null when
 * not established), and `data.loads`, what that binding loads, or [].
 */
export const withLoads = (windows, graph, semantic) => {
  const loads = loadsByVariable(graph);
  const bindings = bindingsByModule(semantic);
  return windows.map((window) => {
    const modulePath = window.data.source_path ?? window.location?.file;
    const all = bindings.get(modulePath) ?? [];
    const binding = window.location ? bindingOf(all, window.location) : null;
    const unique =
      binding !== null &&
      all.filter((candidate) => candidate.name === binding.name).length === 1;
    const targets = unique
      ? (loads.get(modulePath)?.get(binding.name) ?? [])
      : [];
    return {
      ...window,
      data: {
        ...window.data,
        variable: unique ? binding.name : null,
        loads: [...targets].sort(),
      },
    };
  });
};
