// Module relationships from REA's application graph: what each module
// imports and exports, and which modules run in a browser page.
import { edgeFact, firstObservation } from "./provenance.mjs";

/**
 * The file a module node stands for: an asset, a source-map original source,
 * or a module a bundler wrapped inside a file (esbuild's __commonJS modules
 * carry the containing file's path).
 */
export const modulePathOf = (node) => {
  const properties = firstObservation(node)?.properties ?? {};
  if (node.kind === "javascript-asset") return properties.path ?? null;
  const namespace = node.identity?.namespace ?? "";
  if (namespace === "source-module" || namespace.endsWith(":module"))
    return properties.path ?? null;
  return null;
};

/** True for the file names REA analyzes as JavaScript or TypeScript modules. */
export const isScriptPath = (modulePath) =>
  /\.(m?js|cjs|jsx|ts|mts|cts|tsx)$/.test(modulePath);

// Bundler content hashes in file names: `index-Gg77Hh88.js`, `main.3f2a9c1b.js`.
const HASHED_NAME = [
  /-(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{8,}(?=\.(m?js|css)$)/,
  /\.(?=[a-f0-9]*[0-9])[a-f0-9]{8,}(?=(\.chunk)?\.(m?js|css)$)/,
];

/** A module path without its bundler content hash. */
export const withoutHash = (modulePath) =>
  HASHED_NAME.reduce((name, pattern) => name.replace(pattern, ""), modulePath);

const externalSpecifierOf = (edge, target) => {
  const properties = firstObservation(target)?.properties ?? {};
  if (properties.resolution_status !== "external") return null;
  return (
    edge.properties?.specifier ??
    properties.specifier ??
    properties.declared_specifier ??
    null
  );
};

// The module an export-binding node (`export { run }`) belongs to.
const exportModuleOf = (node) => {
  const properties = firstObservation(node)?.properties ?? {};
  return properties.semantic_role === "export-binding"
    ? (properties.module_path ?? null)
    : null;
};

const emptyEntry = () => ({
  externalImports: new Set(),
  externalLocals: new Map(),
  local: new Set(),
  imported: new Map(),
  exports: new Map(),
  reexports: new Map(),
  stars: new Set(),
});

// Exported name → `{ local, range }`: the local binding it exports, or null
// for an anonymous default export, with the export's source range.
const recordExports = (graph, entry) => {
  for (const node of graph.nodes) {
    const modulePath = exportModuleOf(node);
    const observation = firstObservation(node);
    const { exported_name: exported, local_name: local } =
      observation?.properties ?? {};
    const location = observation?.evidence?.location?.value;
    if (modulePath !== null && exported)
      entry(modulePath).exports.set(exported, {
        local: local ?? null,
        range:
          location?.kind === "source-range"
            ? { start: location.start, end: location.end }
            : null,
      });
  }
};

// `export { run } from "./shell.js"` and `export * as ns from`: REA links the
// export binding itself. `export * from` re-exports every name of a module.
const recordReexport = (edge, exporter, targetPath, entry) => {
  const { exported_name: exported, imported_name: imported } =
    edge.properties ?? {};
  if (targetPath === null) return;
  if (exported && exported !== "*")
    entry(exporter).reexports.set(exported, {
      module: targetPath,
      name: imported ?? exported,
    });
  else if (imported === "*") entry(exporter).stars.add(targetPath);
};

const recordImport = (edge, sourcePath, target, entry) => {
  const targetPath = modulePathOf(target);
  const localName = edge.properties?.local_name ?? null;
  if (targetPath !== null) {
    entry(sourcePath).local.add(targetPath);
    if (localName !== null)
      entry(sourcePath).imported.set(localName, {
        module: targetPath,
        name: edge.properties?.imported_name ?? localName,
      });
    return null;
  }
  const specifier = externalSpecifierOf(edge, target);
  if (specifier !== null && localName !== null)
    entry(sourcePath).externalLocals.set(localName, {
      specifier,
      name: edge.properties?.imported_name ?? localName,
    });
  if (specifier === null || entry(sourcePath).externalImports.has(specifier))
    return null;
  entry(sourcePath).externalImports.add(specifier);
  return edgeFact(edge, specifier, { specifier, module: sourcePath });
};

/**
 * Per-module import index: local modules each module imports, external
 * specifiers (Node built-ins and npm packages) and what each external import
 * binds (local name to specifier and imported name), what each import binds
 * (local name to module and imported name), what each module exports
 * (exported name to local name and range), re-exports (exported name to
 * module and imported name) and star re-exports. Also returns one fact per
 * external import edge.
 */
export const importIndex = (graph) => {
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const modules = new Map();
  const entry = (modulePath) => {
    if (!modules.has(modulePath)) modules.set(modulePath, emptyEntry());
    return modules.get(modulePath);
  };
  recordExports(graph, entry);
  const imports = [];
  for (const edge of graph.edges) {
    if (edge.relation !== "imports") continue;
    const source = byId.get(edge.source_node_id);
    const target = byId.get(edge.target_node_id);
    if (source === undefined || target === undefined) continue;
    const exporter = exportModuleOf(source);
    if (exporter !== null) {
      recordReexport(edge, exporter, modulePathOf(target), entry);
      continue;
    }
    const sourcePath = modulePathOf(source);
    const fact =
      sourcePath === null
        ? null
        : recordImport(edge, sourcePath, target, entry);
    if (fact !== null) imports.push(fact);
  }
  return { modules, imports };
};

/** Modules that run in a browser page: HTML-loaded scripts, service workers and everything they import. */
export const browserModules = (graph, modules) => {
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const roots = [];
  for (const edge of graph.edges) {
    if (edge.relation !== "loads") continue;
    const source = byId.get(edge.source_node_id);
    const target = byId.get(edge.target_node_id);
    const loader =
      source?.kind === "electron-renderer" || source?.kind === "service-worker";
    const targetPath = target ? modulePathOf(target) : null;
    if (loader && targetPath !== null) roots.push(targetPath);
  }
  const reached = new Set();
  const visit = (modulePath) => {
    if (reached.has(modulePath)) return;
    reached.add(modulePath);
    for (const next of modules.get(modulePath)?.local ?? []) visit(next);
  };
  roots.forEach(visit);
  return reached;
};
