// How a range of code (an IPC handler, an MCP tool registration) reaches
// process-execution sites. From the range, Release Watch follows REA's
// resolved same-module calls and every binding read (reach-resolve.mjs says
// where each leads), breadth first, once per range. Every path is Release
// Watch's correlation of REA facts, so callers label it heuristic.
import { indexOf, inside } from "./reach-index.mjs";
import { WHOLE_MODULE, followRead } from "./reach-resolve.mjs";

// Path length bound; the search is already bounded by visiting each
// function once, so this only cuts pathological chains.
const MAX_DEPTH = 32;

const callStep = (fn) => ({ kind: "call", name: fn.name, location: null });

const keyOf = (target) => {
  if (target.fn) return target.fn.id;
  if (target.region)
    return `value:${target.region.module}:${JSON.stringify(target.region.range.start)}`;
  return `module:${target.whole}`;
};

// One queued place: its process sites and resolved calls, unless it is an
// initializer, which runs when the module loads, not when the handler does;
// then the bindings it reads, wherever they lead.
const explore = ({ state, reached, visit }, entry) => {
  const { index } = state;
  const { module: current, range: where, steps, readsOnly } = entry;
  if (!readsOnly) {
    for (const { exec } of inside(index.execs.get(current), where))
      if (!reached.has(exec.node_id))
        reached.set(exec.node_id, { exec, steps });
    for (const call of inside(index.calls.get(current), where))
      for (const fn of call.callees.map((id) => index.byId.get(id)))
        if (fn) visit({ fn }, [...steps, callStep(fn)]);
  }
  for (const item of inside(index.reads.get(current), where))
    for (const target of followRead(state, item))
      visit(target, [...steps, target.step]);
};

const search = (app, index, { module, range }) => {
  const reached = new Map();
  const seen = new Set();
  const queue = [{ module, range, steps: [] }];
  const state = { app, index };
  const visit = (target, steps) => {
    const key = keyOf(target);
    if (seen.has(key) || steps.length > MAX_DEPTH) return;
    seen.add(key);
    if (target.fn)
      queue.push({ module: target.fn.module, range: target.fn.range, steps });
    else if (target.region)
      queue.push({ ...target.region, steps, readsOnly: true });
    else queue.push({ module: target.whole, range: WHOLE_MODULE, steps });
  };
  for (let next = 0; next < queue.length; next += 1)
    explore({ state, reached, visit }, queue[next]);
  return reached;
};

/** Every process site reachable from `{ module, range }`: a Map from exec node id to `{ exec, steps }`. */
export const reachedFrom = (app, { module, range }) => {
  const index = indexOf(app);
  const key = `${module}|${JSON.stringify(range)}`;
  if (!index.reached.has(key))
    index.reached.set(key, search(app, index, { module, range }));
  return index.reached.get(key);
};

const kindOf = (steps) => {
  if (steps.length === 0) return "inline";
  if (steps.some((step) => step.kind === "unresolved-import"))
    return "unresolved-import";
  return steps.some((step) => step.kind === "import")
    ? "imported"
    : "local-helper";
};

/**
 * The way code in `module` within `range` reaches `exec`, or null:
 * `{ kind, steps, read }` with kind inline, local-helper, imported or
 * unresolved-import, and `read` the first read step, for citing.
 */
export const reachOf = (app, scope, exec) => {
  if (scope.module === null || scope.range === null) return null;
  const found = reachedFrom(app, scope).get(exec.node_id);
  if (!found) return null;
  return {
    kind: kindOf(found.steps),
    steps: found.steps,
    read: found.steps.find((step) => step.location) ?? null,
  };
};

const importedName = (step) => {
  if (step.member) return `${step.name}.${step.imported}`;
  return step.imported === step.name
    ? step.name
    : `${step.imported} as ${step.name}`;
};

const stepText = (step) => {
  if (step.kind === "call")
    return `calls ${step.name ?? "a function"} through a call REA resolved`;
  if (step.kind === "local")
    return `reads ${step.name}, a function in the same module`;
  if (step.kind === "value" && step.target)
    return `reads ${step.member ? `${step.name}.${step.member}` : step.name}, whose initializer defines ${step.target}`;
  if (step.kind === "value")
    return step.member
      ? `reads ${step.name}.${step.member}, and REA names none of the functions in the initializer of ${step.name}, so Release Watch followed each of them`
      : `reads ${step.name}, whose initializer defines a function`;
  if (step.kind === "initializer")
    return `reads ${step.name}, whose initializer reads further bindings`;

  if (step.kind === "import")
    return `reads ${importedName(step)}, imported from ${step.module}`;
  return `reads ${importedName(step)}, imported from ${step.module}, which Release Watch could not resolve to one of its functions, so it followed the whole module`;
};

/** The unknown a finding carries when a reach path crosses an unresolved import. */
export const reachUnknowns = (paths) =>
  paths.some((path) => path?.kind === "unresolved-import")
    ? [
        "Release Watch could not resolve an import to one of its module's functions, so it followed everything that module does.",
      ]
    : [];

/** One heuristic sentence for a reach path; `owner` names the code that reaches, in lower case. */
export const reachClaim = (path, exec, owner) => {
  const subject = `${owner[0].toUpperCase()}${owner.slice(1)}`;
  if (path.kind === "inline")
    return `${subject} contains ${exec.data.method}() in its source range`;
  const chain = path.steps.map(stepText).join(", which ");
  return `${subject} ${chain}; ${exec.data.method}() runs there. REA reports each read, import and function; Release Watch connects them`;
};
