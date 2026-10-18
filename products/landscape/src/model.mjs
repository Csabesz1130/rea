// The report model every output renders, and report.json as written: the
// products, the map's rows and what they say together, openings, the
// caller's position or a product's trajectory, building blocks, coverage
// and run cost. Strings are scrubbed as Release Watch scrubs its reports
// (redact.mjs): caller-selected paths kept, URL secrets and credential
// formats masked.
import { trajectory } from "./history.mjs";
import { mapRows, position, summarize } from "./map.mjs";
import { openings } from "./opportunities.mjs";
import {
  analysisRecord,
  localPath,
  localText,
  scrubDeep,
} from "./release-watch.mjs";
import { productStack, productTraits } from "./traits/index.mjs";

const MAX_FILES = 20;

/** What every map and brief says it does not establish. */
export const LIMITATIONS = [
  "Landscape reads shipped code statically through REA; it does not run the products. A trait a product does not show was not observed where REA looked, which is not proof the product lacks it.",
  "Traits marked yes rest on REA facts, at times tied together by Release Watch without a guess (a request that reads the variable holding a URL). Traits marked likely rest only on a guess: a URL near a request, a library known to start processes, a host whose name says telemetry.",
  "Requests through HTTP clients and processes through libraries REA does not model, hosts built at runtime and settings read from configuration may not appear.",
  "Bundled code hides which packages it was built from; providers reached through a configurable base URL are not told apart.",
  "Use Landscape only on software you own or are licensed to analyze; some license agreements forbid reverse engineering.",
];

const coverageRecord = (coverage) => ({
  status: coverage.status,
  components: coverage.components.map((part) => ({
    name: part.name,
    status: part.status,
    files: part.files.slice(0, MAX_FILES).map(localPath),
    file_count: part.files.length,
    reason: part.reason,
  })),
});

const productRecord = (product) => ({
  id: product.id,
  role: product.role,
  label: product.label,
  name: product.name,
  version: product.version,
  input: localPath(product.input),
  coverage: localText(coverageRecord(product.coverage)),
  components: product.components.map(({ name, kind, side }) => ({
    name,
    kind,
    evidence_file: localPath(side.appEvidence),
    evidence_id: side.app?.evidence_id ?? null,
    capture_file: localPath(side.capture?.file ?? null),
  })),
  stack: product.stack,
});

const ids = (rows) => rows.map((row) => row.id);

const summaryRecord = (summary) => ({
  universal: ids(summary.universal),
  common: ids(summary.common),
  distinct: summary.distinct.map(({ row, product }) => ({
    row: row.id,
    product: product.id,
  })),
  risks: ids(summary.risks),
});

const positionRecord = (found) =>
  Object.fromEntries(
    Object.entries(found).map(([key, rows]) => [key, ids(rows)]),
  );

// Which compared products use each building block, most used first; a
// package one product alone uses is counted, not listed.
const stackRecord = (compared) => {
  const uses = new Map();
  for (const product of compared) {
    for (const { name, label, kind } of product.stack.sdks) {
      if (!uses.has(name))
        uses.set(name, {
          name,
          label,
          kind: "sdk",
          sdk_kind: kind,
          products: [],
        });
      uses.get(name).products.push(product.id);
    }
    for (const name of product.stack.packages) {
      if (!uses.has(name))
        uses.set(name, {
          name,
          label: null,
          kind: "package",
          sdk_kind: null,
          products: [],
        });
      uses.get(name).products.push(product.id);
    }
  }
  const all = [...uses.values()].sort(
    (a, b) =>
      b.products.length - a.products.length || a.name.localeCompare(b.name),
  );
  const shared = all.filter(
    (use) => use.kind === "sdk" || use.products.length > 1,
  );
  return { shared, single_use_packages: all.length - shared.length };
};

/**
 * The report model. `products` are collected products (products.mjs) with
 * roles "competitor" and at most one "ours" for a map, "release" for a
 * history; `run` holds `{ mode, category, settings, reaCalls, startedAt,
 * elapsedMs }`.
 */
export const buildModel = (collected, run) => {
  const products = collected.map((product) => {
    const withTraits = { ...product, traits: productTraits(product) };
    return { ...withTraits, stack: productStack(withTraits) };
  });
  const compared = products.filter((product) => product.role !== "ours");
  const ours = products.find((product) => product.role === "ours") ?? null;
  const rows = mapRows(products, compared);
  const history = run.mode === "history";
  return scrubDeep({
    tool: "landscape",
    schema: 1,
    mode: run.mode,
    category: run.category,
    generated_at: new Date(run.startedAt).toISOString(),
    products: products.map(productRecord),
    rows,
    summary: summaryRecord(summarize(rows, compared)),
    openings: history ? [] : openings(rows, compared.length),
    position: ours ? positionRecord(position(rows, ours, compared)) : null,
    trajectory: history ? trajectory(rows, compared) : null,
    stack: stackRecord(compared),
    analysis: analysisRecord(run.settings),
    rea_calls: run.reaCalls,
    elapsed_ms: run.elapsedMs,
    errors: localText(
      products.flatMap((product) =>
        product.errors.map((error) => ({ product: product.id, ...error })),
      ),
    ),
    limitations: LIMITATIONS,
  });
};
