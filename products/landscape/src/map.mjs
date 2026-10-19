// The category map: one row per trait any product holds or leaves unknown,
// one cell per product, and what the competitors' cells say together. A
// product that does not show a trait where REA examined all of its code is
// "no" (not observed, which is not proof of absence); where REA examined it
// in part, or a reason recorded with the trait applies, it is "unknown".
import { GROUPS, TRAITS, isProviderTrait } from "./traits/definitions.mjs";

const HELD = new Set(["yes", "likely"]);

/** True when a cell says the product shows the trait. */
export const isHeld = (cell) => HELD.has(cell.state);

const coverageReason = (product) => {
  if (product.coverage.status === "none")
    return "REA produced no application facts for this product";
  const files = product.coverage.components.flatMap((part) => part.files);
  return files.length > 0
    ? `REA examined ${files.length} file${files.length === 1 ? "" : "s"} of this product only in part or not at all`
    : "REA examined this product's code only in part";
};

/** One product's cell for one trait. */
export const cellOf = (product, definition) => {
  const held = product.traits.held.get(definition.id);
  if (held)
    return {
      state: held.strength,
      evidence: held.evidence,
      evidence_count: held.evidence_count,
      values: held.values,
    };
  const reasons = [
    ...(product.traits.unknown.get(definition.id)?.reasons ?? []),
    ...(product.coverage.status === "complete"
      ? []
      : [coverageReason(product)]),
  ];
  if (reasons.length > 0) return { state: "unknown", reasons };
  return {
    state: "no",
    notes: product.traits.notes.get(definition.id)?.notes ?? [],
  };
};

const STATIC_ORDER = new Map(
  Object.values(TRAITS).map((definition, index) => [definition.id, index]),
);
const GROUP_ORDER = new Map(GROUPS.map((group, index) => [group.id, index]));

// The traits a row is kept for: held by some product, or left unknown for
// a reason of its own (a library REA does not model, a value it did not
// resolve) rather than only for partial coverage.
const rowDefinitions = (products) => {
  const found = new Map();
  for (const product of products) {
    for (const trait of product.traits.held.values())
      found.set(trait.id, trait);
    for (const { definition } of product.traits.unknown.values())
      if (!found.has(definition.id)) found.set(definition.id, definition);
  }
  return [...found.values()].map(({ id, group, kind, label, provider }) => ({
    id,
    group,
    kind,
    label,
    ...(provider ? { provider } : {}),
  }));
};

const countsOf = (cells, products) => {
  const counts = { yes: 0, likely: 0, no: 0, unknown: 0 };
  for (const product of products) counts[cells[product.id].state] += 1;
  return { ...counts, held: counts.yes + counts.likely };
};

// Rows by group; providers first within AI, by how many products call them.
const compareRows = (a, b) =>
  GROUP_ORDER.get(a.group) - GROUP_ORDER.get(b.group) ||
  Number(isProviderTrait(b.id)) - Number(isProviderTrait(a.id)) ||
  (isProviderTrait(a.id)
    ? b.counts.held - a.counts.held || a.label.localeCompare(b.label)
    : STATIC_ORDER.get(a.id) - STATIC_ORDER.get(b.id));

/**
 * The map's rows: `[{ id, group, kind, label, cells, counts }]`, `cells`
 * keyed by product id for every product, `counts` over `compared` (the
 * products the summary speaks for).
 */
export const mapRows = (products, compared) =>
  rowDefinitions(products)
    .map((definition) => {
      const cells = Object.fromEntries(
        products.map((product) => [product.id, cellOf(product, definition)]),
      );
      return { ...definition, cells, counts: countsOf(cells, compared) };
    })
    .sort(compareRows);

const holderOf = (row, products) =>
  products.find((product) => isHeld(row.cells[product.id]));

/**
 * What the compared products' cells say together: capabilities every one
 * shows (`universal`), most show (`common`, more than half) and exactly one
 * shows when there are three or more (`distinct`, with that product), and
 * every risk some product shows, most widespread first.
 */
export const summarize = (rows, compared) => {
  const n = compared.length;
  const capability = rows.filter((row) => row.kind === "capability");
  return {
    universal: n >= 2 ? capability.filter((row) => row.counts.held === n) : [],
    common: capability.filter(
      (row) => row.counts.held < n && row.counts.held * 2 > n,
    ),
    distinct:
      n >= 3
        ? capability
            .filter((row) => row.counts.held === 1)
            .map((row) => ({ row, product: holderOf(row, compared) }))
        : [],
    risks: rows
      .filter((row) => row.kind === "risk" && row.counts.held > 0)
      .sort((a, b) => b.counts.held - a.counts.held),
  };
};

/**
 * Where the caller's own product stands against the compared ones:
 * `matches` and `gaps` among the capabilities most of them show, `edges`
 * (capabilities it shows that none of them does), `risks` it shares and
 * `clear` (risks most of them show that it does not, where REA examined
 * all of its code).
 */
export const position = (rows, ours, compared) => {
  const n = compared.length;
  const most = (row) => row.counts.held * 2 > n;
  const mine = (row) => row.cells[ours.id];
  const capability = rows.filter((row) => row.kind === "capability");
  const risk = rows.filter((row) => row.kind === "risk");
  return {
    matches: capability.filter((row) => most(row) && isHeld(mine(row))),
    gaps: capability.filter((row) => most(row) && !isHeld(mine(row))),
    edges: capability.filter(
      (row) => row.counts.held === 0 && isHeld(mine(row)),
    ),
    risks: risk.filter((row) => isHeld(mine(row))),
    clear: risk.filter((row) => most(row) && mine(row).state === "no"),
  };
};
