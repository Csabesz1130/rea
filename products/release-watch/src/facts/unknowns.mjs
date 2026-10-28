// Facts from REA's semantic unknowns that point at source: what REA reports
// it could not resolve, where it could not resolve it.
import { semanticFact } from "./provenance.mjs";

// REA's semantic unknowns of one reason, one fact each.
const unknownsOf = (semantic, contexts, reason, suffix) =>
  (semantic.unknowns ?? []).flatMap((unknown) => {
    const location = unknown.evidence?.location?.value;
    if (unknown.reason !== reason || location?.kind !== "source-range")
      return [];
    return [
      semanticFact(
        { ...unknown, node_id: unknown.unknown_id },
        contexts,
        `${location.source}#${suffix}`,
        { module: location.source, detail: unknown.detail ?? null },
      ),
    ];
  });

/**
 * Dynamic evaluation REA reports as an unknown scope: a direct eval. REA
 * reports new Function and an indirect eval as dynamic calls instead.
 */
export const dynamicEvaluation = (semantic, contexts) =>
  unknownsOf(semantic, contexts, "dynamic-scope", "eval");

/**
 * Calls REA cannot resolve to a function, reported where the callee starts:
 * a call of a computed or unknown value, new Function, an indirect eval, a
 * require of an expression.
 */
export const dynamicCalls = (semantic, contexts) =>
  unknownsOf(semantic, contexts, "dynamic-call", "call");
