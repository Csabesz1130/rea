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
  externalSites: [],
  unresolvedSites: [],
  externalExports: new Map(),
  local: new Set(),
  localSites: [],
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

// One import edge as REA reports it: the binding it creates (`local`, null
// when it creates none, as for `require(...).exec` or a dynamic import),
// the imported name and property path, how it was written (`require`,
// `import`, `static-import`, `dynamic-import`, or for an export
// `export`, `re-export`, `commonjs-export`) and its source range.
const siteOf = (edge, key, extra) => {
  const properties = edge.properties ?? {};
  const location = edge.evidence?.location?.value;
  return edgeFact(edge, key, {
    ...extra,
    local: properties.local_name ?? null,
    imported: properties.imported_name ?? null,
    path: properties.imported_path ?? null,
    form: properties.kind ?? properties.module_link_kind ?? null,
    range:
      location?.kind === "source-range"
        ? { start: location.start, end: location.end }
        : null,
  });
};

// `export { run } from "./shell.js"` and `export * as ns from`: REA links the
// export binding itself. `export * from` re-exports every name of a module.
// An export REA traces to an external module (`export { execSync } from
// "node:child_process"`, `module.exports = require("child_process")`,
// `exports.spawn = spawn`) is kept by exported name, with the external
// module's name or property path it holds.
const recordReexport = (edge, exporter, target, entry) => {
  const { exported_name: exported, imported_name: imported } =
    edge.properties ?? {};
  const targetPath = modulePathOf(target);
  if (targetPath === null) {
    const specifier = externalSpecifierOf(edge, target);
    if (specifier !== null && exported)
      entry(exporter).externalExports.set(
        exported,
        siteOf(edge, specifier, { specifier }),
      );
    return;
  }
  if (exported && exported !== "*")
    entry(exporter).reexports.set(exported, {
      module: targetPath,
      name: imported ?? exported,
      form: edge.properties?.module_link_kind ?? edge.properties?.kind ?? null,
    });
  else if (imported === "*") entry(exporter).stars.add(targetPath);
};

// A load REA resolved to no module (`require(name)`); REA renders its
// expression.
const isUnresolvedLoad = (target) =>
  firstObservation(target)?.properties?.resolution === "unresolved";

const recordImport = (edge, sourcePath, target, entry) => {
  const targetPath = modulePathOf(target);
  const localName = edge.properties?.local_name ?? null;
  if (targetPath !== null) {
    entry(sourcePath).local.add(targetPath);
    entry(sourcePath).localSites.push(
      siteOf(edge, targetPath, {
        module: targetPath,
        specifier: edge.properties?.specifier ?? null,
      }),
    );
    if (localName !== null)
      entry(sourcePath).imported.set(localName, {
        module: targetPath,
        name: edge.properties?.imported_name ?? localName,
      });
    return null;
  }
  const specifier = externalSpecifierOf(edge, target);
  if (specifier === null && isUnresolvedLoad(target))
    entry(sourcePath).unresolvedSites.push(
      siteOf(edge, edge.properties?.expression ?? "load", {
        expression: edge.properties?.expression ?? null,
      }),
    );
  if (specifier !== null)
    entry(sourcePath).externalSites.push(
      siteOf(edge, specifier, { specifier }),
    );
  if (specifier === null || entry(sourcePath).externalImports.has(specifier))
    return null;
  entry(sourcePath).externalImports.add(specifier);
  return edgeFact(edge, specifier, { specifier, module: sourcePath });
};

/**
 * Per-module import index: local modules each module imports, with every
 * such import edge and its range (`localSites`); external specifiers
 * (Node built-ins and npm packages) with every external import edge and
 * its range (`externalSites`); loads REA resolved to no module
 * (`unresolvedSites`); what each import binds (local name to module and
 * imported name); what each module exports (exported name to local name
 * and range); re-exports (exported name to module and imported name),
 * star re-exports, and exports REA traces to an external module
 * (`externalExports`, by exported name). Also returns one fact per
 * external import specifier and module.
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
      recordReexport(edge, exporter, target, entry);
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
