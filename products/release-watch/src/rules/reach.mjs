// How a range of code (an IPC handler, an MCP tool registration) reaches a
// process-execution site. Same-module calls follow REA's resolved call
// edges; a call into another module follows an imported binding only into
// the function of that name whose body holds the exec site. Every path is
// Release Watch's correlation of REA facts, so callers label it heuristic.
import { within } from "./shared.mjs";

const MAX_DEPTH = 6;

// The function ranges a set of ranges reaches through REA's same-module call
// edges, the starting ranges included.
const closure = (app, module, ranges) => {
  const reached = [...ranges];
  const seen = new Set();
  for (
    let depth = 0, frontier = ranges;
    depth < MAX_DEPTH && frontier.length > 0;
    depth += 1
  ) {
    const next = [];
    for (const edge of app.callEdges ?? [])
      if (
        edge.module === module &&
        edge.target.module === module &&
        frontier.some((range) => within(edge.range, range))
      ) {
        const key = JSON.stringify(edge.target.range);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(edge.target.range);
      }
    reached.push(...next);
    frontier = next;
  }
  return reached;
};

const readsIn = (app, module, ranges) =>
  app.bindingReads.filter(
    (read) =>
      read.data.module === module &&
      ranges.some((range) => within(read.data.range, range)),
  );

// Functions named `name` in `module` whose body, or a same-module function it
// calls, holds the exec site.
const callableReaching = (app, module, name, exec) =>
  (app.callables ?? []).find(
    (callable) =>
      callable.module === module &&
      callable.name === name &&
      closure(app, module, [callable.range]).some((range) =>
        within(exec.data.range, range),
      ),
  ) ?? null;

/**
 * The way code in `module` within `range` reaches `exec`, or null:
 * - "inline": the exec site lies inside the range;
 * - "local-helper": the range calls, through REA's call edges or a read of a
 *   function binding, a function in the same module that holds the site;
 * - "imported": the range reads a binding imported from the exec's module,
 *   and the function of that name there holds the site.
 */
export const reachOf = (app, { module, range }, exec) => {
  if (module === null || range === null) return null;
  if (exec.data.module === module && within(exec.data.range, range))
    return { kind: "inline" };
  const ranges = closure(app, module, [range]);
  if (exec.data.module === module) {
    if (ranges.some((reached) => within(exec.data.range, reached)))
      return { kind: "local-helper", read: null };
    for (const read of readsIn(app, module, ranges))
      if (callableReaching(app, module, read.data.name, exec))
        return { kind: "local-helper", read };
    return null;
  }
  const imported = app.modules.get(module)?.imported ?? new Map();
  for (const read of readsIn(app, module, ranges))
    if (
      imported.get(read.data.name) === exec.data.module &&
      callableReaching(app, exec.data.module, read.data.name, exec)
    )
      return { kind: "imported", read };
  return null;
};

const sentence = (text) => `${text[0].toUpperCase()}${text.slice(1)}`;

/** One heuristic sentence for a reach path; `owner` names the code that reaches, in lower case. */
export const reachClaim = (path, exec, owner) =>
  sentence(claimText(path, exec, owner));

const claimText = (path, exec, owner) => {
  if (path.kind === "inline")
    return `${exec.data.method}() lies inside the source range of ${owner}`;
  if (path.kind === "imported")
    return `${owner} reads ${path.read.data.name}, imported from ${exec.data.module}, where the function of that name holds ${exec.data.method}(); REA reports the import, the read and the function, Release Watch connects them`;
  return path.read
    ? `${owner} reads ${path.read.data.name}, a function in the same module whose body holds ${exec.data.method}(); REA reports the read and the function, Release Watch connects them`
    : `${owner} calls a function in the same module that holds ${exec.data.method}(), through REA's resolved call edges`;
};
