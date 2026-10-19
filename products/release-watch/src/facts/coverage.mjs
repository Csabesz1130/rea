// REA's coverage of an application analysis as Release Watch reports it:
// truncation, node ceilings and the files they left partly or wholly
// unexamined. Derived from REA's own limits and retained nodes.
import { isDeclarationPath, isScriptPath } from "./modules.mjs";

// Script files whose semantic facts Release Watch reads: a TypeScript
// declaration file runs nothing, so no rule reads semantic facts of it and
// none it lacks is unexamined code.
const runsCode = (modulePath) =>
  isScriptPath(modulePath) && !isDeclarationPath(modulePath);

// Modules whose semantic node count reached REA's per-file ceiling: where a
// truncated graph dropped facts. Derived from REA's own limit and nodes.
const ceilingModules = (semantic) => {
  const ceiling = semantic?.coverage?.limits?.find(
    (limit) => limit.name === "semantic_graph_file_node_ceiling",
  )?.value;
  if (!semantic?.coverage?.truncated || !ceiling) return [];
  const counts = new Map();
  for (const node of semantic.nodes) {
    const modulePath = node.identity?.module_path;
    if (modulePath) counts.set(modulePath, (counts.get(modulePath) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count >= ceiling)
    .map(([modulePath]) => modulePath)
    .sort();
};

// Whether the semantic graph reached REA's global node ceiling. REA builds
// files in interleaved steps, so the retained nodes do not say which files
// it cut short: any analyzed file may be partial then.
const globalLimitReached = (semantic) => {
  const ceiling = semantic?.coverage?.limits?.find(
    (limit) => limit.name === "semantic_graph_node_ceiling",
  )?.value;
  return Boolean(
    semantic?.coverage?.truncated &&
    ceiling &&
    semantic.nodes.length >= ceiling,
  );
};

/** REA's coverage of both graphs, as Release Watch reports it. */
export const coverageOf = (graph, semantic) => ({
  graph: graph.coverage?.status ?? "unknown",
  graph_truncated: graph.coverage?.truncated === true,
  graph_omitted: graph.coverage?.omitted_count ?? 0,
  semantic: semantic?.coverage?.status ?? "unavailable",
  semantic_truncated: semantic?.coverage?.truncated === true,
  semantic_omitted_nodes: semantic?.coverage?.omitted_nodes ?? null,
  semantic_limits: (semantic?.coverage?.limits ?? []).map(
    (limit) =>
      `${limit.name} ${limit.value}${limit.unit === "items" ? "" : ` ${limit.unit}`}`,
  ),
  semantic_ceiling_modules: ceilingModules(semantic),
  semantic_global_limit_reached: globalLimitReached(semantic),
});

// Script files with no semantic node at all when REA truncated the semantic
// graph: the global ceiling left them unexamined. Declaration files are not
// listed (runsCode).
export const unreachedModules = (semantic, assets) => {
  if (!semantic?.coverage?.truncated) return [];
  const reached = new Set(
    semantic.nodes.map((node) => node.identity?.module_path).filter(Boolean),
  );
  return assets
    .map((asset) => asset.key)
    .filter((key) => runsCode(key) && !reached.has(key))
    .sort();
};

/**
 * REA's analysis failures of one app by the file they name: `[{ file,
 * failures }]`, one entry per file, and one per failure that names no file
 * (`file` null). REA can record several failures for one file, such as its
 * semantic graph and its expanded relationships exceeding its result budget.
 */
export const failedFiles = (app) => {
  const byFile = new Map();
  (app?.analysisFailures ?? []).forEach((failure, index) => {
    const file = failure.location?.file ?? null;
    const key = file ?? `#${index}`;
    if (!byFile.has(key)) byFile.set(key, { file, failures: [] });
    byFile.get(key).failures.push(failure);
  });
  return [...byFile.values()];
};

/**
 * What REA left unexamined in one app: `files`, each file it examined in
 * part or not at all with why ("ceiling": the per-file node ceiling,
 * "unreached": no semantic node after the global limit, "failed": a failed
 * or unparsed file), and `anyFile`, true when REA reached its global node
 * limit, so any file may be partial. Empty for no app.
 */
export const unexaminedIn = (app) => {
  const files = new Map();
  const add = (file, reason) => {
    if (file && !files.has(file)) files.set(file, reason);
  };
  for (const file of app?.coverage.semantic_ceiling_modules ?? [])
    add(file, "ceiling");
  for (const file of app?.coverage.semantic_unreached_modules ?? [])
    add(file, "unreached");
  for (const { file } of failedFiles(app)) add(file, "failed");
  return {
    files,
    anyFile: app?.coverage.semantic_global_limit_reached === true,
  };
};

/**
 * Files of one app whose imports REA's graph does not report: files REA
 * recorded a failure for and no import relationship from, as when it
 * rejected a file's expanded relationships on its result budget or could
 * not analyze the file at all. What they import is unknown, not nothing.
 */
export const importsUnknown = (app) => {
  const reported = (file) => {
    const entry = app.modules.get(file);
    return (
      entry !== undefined &&
      (entry.local.size > 0 ||
        entry.externalImports.size > 0 ||
        entry.unresolvedSites.length > 0)
    );
  };
  return new Set(
    failedFiles(app)
      .map(({ file }) => file)
      .filter((file) => file !== null && !reported(file)),
  );
};

/**
 * The files of one analyzed app REA examined only in part or not at all:
 * each file unexaminedIn names, then every script file but a declaration
 * file (runsCode) once REA reached its global node limit, since REA does not
 * say which files it cut short.
 */
export const examinedInPart = (app) => {
  const { files, anyFile } = unexaminedIn(app);
  return [
    ...files.keys(),
    ...(anyFile ? app.assets.map((asset) => asset.key).filter(runsCode) : []),
  ];
};

/**
 * A test for the files of one app whose semantic facts REA may not report
 * in full: those examinedInPart lists, and every file when REA produced no
 * semantic graph. What REA does not report there is unknown, not absent.
 */
export const partlyExamined = (app) => {
  if (!app) return () => false;
  if (app.coverage.semantic === "unavailable") return () => true;
  const files = new Set(examinedInPart(app));
  return (module) => files.has(module);
};
