// How a range of code (an IPC handler, an MCP tool registration) reaches a
// process-execution site, connected from REA facts by location. Every path
// is Release Watch's correlation, so callers label it heuristic.
import { within } from "./shared.mjs";

const readsIn = (app, module, range) =>
  app.bindingReads.filter(
    (read) => read.data.module === module && within(read.data.range, range),
  );

/**
 * The way code in `module` within `range` reaches `exec`, or null:
 * - "inline": the exec site lies inside the range;
 * - "imported": the range reads a binding imported from the exec's module;
 * - "local-helper": the range reads a binding whose definition, in the same
 *   module, contains the exec site.
 */
export const reachOf = (app, { module, range }, exec) => {
  if (module === null || range === null) return null;
  if (exec.data.module === module && within(exec.data.range, range))
    return { kind: "inline" };
  const reads = readsIn(app, module, range);
  const imported = app.modules.get(module)?.imported ?? new Map();
  const viaImport = reads.find(
    (read) => imported.get(read.data.name) === exec.data.module,
  );
  if (viaImport) return { kind: "imported", read: viaImport };
  if (exec.data.module !== module) return null;
  for (const read of reads) {
    const definition = (app.bindingDefinitions ?? []).find(
      (candidate) =>
        candidate.data.module === module &&
        candidate.data.name === read.data.name &&
        within(exec.data.range, candidate.data.range),
    );
    if (definition) return { kind: "local-helper", read, definition };
  }
  return null;
};

/** One heuristic sentence for a reach path. */
export const reachClaim = (path, exec, owner) => {
  if (path.kind === "inline")
    return `${exec.data.method}() lies inside ${owner}'s source range`;
  if (path.kind === "imported")
    return `${owner} reads ${path.read.data.name}, which its module imports from ${exec.data.module}; REA reports the import and the read, Release Watch connects them`;
  return `${owner} reads ${path.read.data.name}, a function defined in the same module whose body contains ${exec.data.method}(); REA reports the read and the definition, Release Watch connects them`;
};
