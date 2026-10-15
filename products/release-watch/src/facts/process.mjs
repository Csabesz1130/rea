// REA's unknowns where a process call may have gone unclassified: values or
// calls REA could not resolve that name a process API, and computed member
// calls on a child_process import (`cp[method](...)`), whose function REA
// cannot know.
import { sameStart, within } from "../ranges.mjs";
import { semanticFact } from "./provenance.mjs";

// Process APIs whose names in an REA unknown mean a process call REA could
// not classify. Plain `exec` is left out: RegExp.prototype.exec shares it.
const PROCESS_NAME =
  /\b(execSync|execFile|execFileSync|spawn|spawnSync|fork|child_process)\b/;
const PROCESS_MODULE = /^(?:node:)?child_process$/;

const sourceRange = (unknown) => {
  const location = unknown.evidence?.location?.value;
  return location?.kind === "source-range" ? location : null;
};

// Unknowns whose text names a process API.
const namedGaps = (semantic, contexts) =>
  (semantic.unknowns ?? []).flatMap((unknown) => {
    const location = sourceRange(unknown);
    const name = PROCESS_NAME.exec(unknown.detail ?? "")?.[1];
    if (!location || !name) return [];
    return [
      semanticFact(
        { ...unknown, node_id: unknown.unknown_id },
        contexts,
        `${location.source}#${name}`,
        { module: location.source, name, detail: unknown.detail ?? null },
      ),
    ];
  });

// REA notes unknowns about every imported process API, even where it then
// classified the call. An unknown counts only when REA classified no process
// site of that API in the module (for child_process itself, none at all).
const unclassified = (unknowns, childProcesses) => {
  const classified = new Set(
    childProcesses.flatMap((fact) => [
      `${fact.data.module}#${fact.data.method}`,
      `${fact.data.module}#child_process`,
    ]),
  );
  return unknowns.filter(
    (unknown) => !classified.has(`${unknown.data.module}#${unknown.data.name}`),
  );
};

// Computed member reads REA could not resolve (`cp[method]`), whose receiver
// is a binding the module imports from child_process. The receiver is the
// binding read REA reports where the member read starts.
const computedGaps = (semantic, contexts, { modules, bindingReads }) => {
  const reads = semantic.nodes.filter(
    (node) =>
      node.kind === "expression" &&
      node.label === "read" &&
      node.properties?.property_path == null &&
      node.identity?.source_range,
  );
  return (semantic.unknowns ?? []).flatMap((unknown) => {
    const location = sourceRange(unknown);
    if (unknown.reason !== "dynamic-property" || !location) return [];
    const module = location.source;
    const locals = modules.get(module)?.externalLocals;
    const read = reads.find(
      (node) =>
        node.identity.module_path === module &&
        within(location, node.identity.source_range),
    );
    const receiver =
      read &&
      bindingReads.find(
        (fact) =>
          fact.data.module === module &&
          sameStart(fact.data.range, read.identity.source_range),
      );
    const imported = receiver && locals?.get(receiver.data.name);
    if (!imported || !PROCESS_MODULE.test(imported.specifier)) return [];
    const { start } = read.identity.source_range;
    return [
      semanticFact(
        { ...unknown, node_id: unknown.unknown_id },
        contexts,
        `${module}#child_process@${start.line}:${start.column}`,
        {
          module,
          name: "child_process",
          receiver: receiver.data.name,
          computed: true,
          detail: unknown.detail ?? null,
        },
      ),
    ];
  });
};

/**
 * Process gaps of one semantic graph. `modules` is the import index (for
 * the local names of external imports); `childProcesses` and
 * `bindingReads` are the facts already projected from the graph.
 */
export const processUnknowns = (semantic, contexts, facts) => [
  ...unclassified(namedGaps(semantic, contexts), facts.childProcesses),
  ...computedGaps(semantic, contexts, facts),
];
