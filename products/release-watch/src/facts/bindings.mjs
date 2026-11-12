// Bindings in REA's semantic graph: what defines each one, where each is
// read, and which hold one constant. application.mjs projects literals and
// the rest of the graph; loads.mjs and the destination rules read these
// facts.
import { semanticFact } from "./provenance.mjs";

const rangeOf = (node) => node.identity?.source_range ?? null;

// The node REA reports for a declaration's own binding (`const name`), which
// defines the binding beside the value it is declared with.
const DECLARATION = "variable";

/**
 * What defines each binding, and each binding read. Returns the binding a
 * definition node defines, by that node's id: `{ name, range, constant }`,
 * with `constant` true for the one literal that is the binding's only
 * value: REA reports no other literal for it (as it does for `a ? "x" :
 * "y"`), no assignment to it and no import, parameter or catch clause
 * behind it, only its declaration. Binding reads are appended to
 * `facts.bindingReads`.
 */
export const bindingRelations = (semantic, facts, contexts) => {
  const byId = new Map(semantic.nodes.map((node) => [node.node_id, node]));
  const definedBinding = new Map();
  const definers = new Map();
  for (const relation of semantic.relations) {
    const source = byId.get(relation.source_node_id);
    const target = byId.get(relation.target_node_id);
    if (relation.relation === "defines" && target?.kind === "binding") {
      definedBinding.set(relation.source_node_id, {
        name: target.label ?? null,
        range: rangeOf(target),
        constant: false,
      });
      if (!definers.has(target.node_id)) definers.set(target.node_id, []);
      definers.get(target.node_id).push(source);
    }
    const readsBinding =
      relation.relation === "reads" && source?.kind === "binding";
    if (!readsBinding || !rangeOf(target ?? {})) continue;
    const modulePath = source.identity?.module_path ?? null;
    facts.bindingReads.push(
      semanticFact(target, contexts, `${modulePath}#${source.label}`, {
        module: modulePath,
        name: source.label,
        range: rangeOf(target),
        binding_range: rangeOf(source),
        binding_owner: source.function_node_id ?? null,
      }),
    );
  }
  for (const sources of definers.values()) {
    const literals = sources.filter((node) => node?.kind === "literal");
    const others = sources.filter((node) => node?.kind !== "literal");
    if (
      literals.length === 1 &&
      others.every(
        (node) => node?.kind === "expression" && node.label === DECLARATION,
      )
    )
      definedBinding.get(literals[0].node_id).constant = true;
  }
  return definedBinding;
};
