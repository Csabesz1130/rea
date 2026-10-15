// The parts of REA's semantic graph that say which code can run which code:
// functions with their own ranges, the calls REA resolved within a module,
// and member reads (`shell.run`).
// Ranges and node ids only; no source is read.

const rangeOf = (node) => node?.identity?.source_range ?? null;
const moduleOf = (node) => node?.identity?.module_path ?? null;
const MEMBER_READ = /^read:\/(.+)$/;

const functionsOf = (semantic) =>
  semantic.nodes
    .filter((node) => node.kind === "function" && rangeOf(node))
    .map((node) => ({
      id: node.node_id,
      module: moduleOf(node),
      name: node.properties?.name ?? null,
      range: rangeOf(node),
    }));

// Call sites REA resolved to functions of the same module.
const callsOf = (semantic, byId) => {
  const callees = new Map();
  for (const relation of semantic.relations) {
    if (relation.relation !== "calls") continue;
    if (byId.get(relation.target_node_id)?.kind !== "function") continue;
    const list = callees.get(relation.source_node_id) ?? [];
    list.push(relation.target_node_id);
    callees.set(relation.source_node_id, list);
  }
  return [...callees].flatMap(([id, targets]) => {
    const site = byId.get(id);
    return site?.kind === "call-site" && rangeOf(site)
      ? [
          {
            module: moduleOf(site),
            range: rangeOf(site),
            callees: targets,
          },
        ]
      : [];
  });
};

// Property reads (`shell.run`), with REA's read path below the object.
const membersOf = (semantic) =>
  semantic.nodes.flatMap((node) => {
    const path =
      node.kind === "expression"
        ? MEMBER_READ.exec(node.label ?? "")?.[1].split("/")
        : null;
    return path && rangeOf(node)
      ? [{ module: moduleOf(node), range: rangeOf(node), path }]
      : [];
  });

// Declared bindings (not parameters), with their owning function, so a read
// can be resolved to what the binding's initializer defines.
const bindingsOf = (semantic) =>
  semantic.nodes
    .filter((node) => node.kind === "binding" && node.label && rangeOf(node))
    .map((node) => ({
      module: moduleOf(node),
      name: node.label,
      range: rangeOf(node),
      owner: node.function_node_id ?? null,
    }));

/**
 * `{ functions, calls, members, bindings }` from one semantic graph. Binding reads are
 * projected with the other semantic facts, in application.mjs.
 */
export const callGraph = (semantic) => {
  if (!semantic) return { functions: [], calls: [], members: [], bindings: [] };
  const byId = new Map(semantic.nodes.map((node) => [node.node_id, node]));
  return {
    functions: functionsOf(semantic),
    calls: callsOf(semantic, byId),
    members: membersOf(semantic),
    bindings: bindingsOf(semantic),
  };
};
