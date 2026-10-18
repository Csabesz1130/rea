// One product's traits while the group readers record them: each trait it
// holds, how strongly ("yes" when REA facts show it, directly or tied
// together without a guess, "likely" when only a guess does), its evidence
// and the values it names; the traits REA's facts cannot settle, with why;
// and notes that qualify a trait the product does not hold.

const MAX_EVIDENCE = 6;

const addAll = (target, values) => {
  for (const value of values) target.add(value);
};

/** An empty trait set: `add`, `unknownBecause`, `note`, then `finish()`. */
export const createTraitSet = () => {
  const held = new Map();
  const unknown = new Map();
  const notes = new Map();
  return {
    add(definition, { strength = "yes", evidence = [], values = [] } = {}) {
      if (!held.has(definition.id))
        held.set(definition.id, {
          definition,
          yes: [],
          likely: [],
          values: new Set(),
        });
      const entry = held.get(definition.id);
      entry[strength].push(...evidence);
      addAll(entry.values, values);
    },
    unknownBecause(definition, reason) {
      if (!unknown.has(definition.id))
        unknown.set(definition.id, { definition, reasons: new Set() });
      unknown.get(definition.id).reasons.add(reason);
    },
    note(definition, text) {
      if (!notes.has(definition.id))
        notes.set(definition.id, { definition, notes: new Set() });
      notes.get(definition.id).notes.add(text);
    },
    holds: (definition) => held.has(definition.id),
    strengthOf: (definition) => {
      const entry = held.get(definition.id);
      if (!entry) return null;
      return entry.yes.length > 0 ? "yes" : "likely";
    },
    entries: () => [...held.values()],
    /**
     * The finished traits: `held` (id → `{ ...definition, strength,
     * evidence, evidence_count, values }`, evidence from REA facts first and
     * at most six lines), `unknown` (id → `{ definition, reasons }`) for
     * traits not held, and `notes` (id → `{ definition, notes }`).
     */
    finish() {
      const done = new Map();
      for (const [id, entry] of held) {
        const evidence = [...entry.yes, ...entry.likely];
        done.set(id, {
          ...entry.definition,
          strength: entry.yes.length > 0 ? "yes" : "likely",
          evidence: evidence.slice(0, MAX_EVIDENCE),
          evidence_count: evidence.length,
          values: [...entry.values].sort(),
        });
      }
      const open = new Map(
        [...unknown]
          .filter(([id]) => !held.has(id))
          .map(([id, entry]) => [
            id,
            { definition: entry.definition, reasons: [...entry.reasons] },
          ]),
      );
      const qualified = new Map(
        [...notes]
          .filter(([id]) => !held.has(id))
          .map(([id, entry]) => [
            id,
            { definition: entry.definition, notes: [...entry.notes] },
          ]),
      );
      return { held: done, unknown: open, notes: qualified };
    },
  };
};
