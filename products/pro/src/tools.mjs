import { z } from "zod";
import { account } from "./auth.mjs";
const text = z.string().min(1).max(2048);
const pages = {
  limit: z.int().min(1).max(100).default(10),
  offset: z.int().min(0).default(0),
};
const graph = () => import("./graph.mjs");
const recovery = () => import("./recovery.mjs");

// Each entry owns the same input schema and handler for both public adapters.
// Resource paths are fixed by the operator when starting stdio.
export const operations = [
  {
    cli: "search",
    name: "graph_search",
    feature: "graph",
    resource: "store",
    args: ["query"],
    description:
      "Rank graph nodes by local TF-IDF cosine similarity and return Evidence locations.",
    input: z.strictObject({ query: text, kind: text.optional(), ...pages }),
    run: async (p, i) =>
      (await graph()).searchGraph(p, i.query, i.limit, i.offset, i.kind),
  },
  {
    cli: "slice",
    name: "graph_slice",
    feature: "graph",
    resource: "store",
    args: ["id"],
    description:
      "Read a directed graph neighborhood within a cl100k_base budget for the complete compact JSON payload.",
    input: z.strictObject({
      id: text,
      evidence_id: text.optional(),
      hops: z.int().min(0).max(12).default(2),
      direction: z.enum(["both", "in", "out"]).default("both"),
      relation: text.optional(),
      budget: z.int().min(64).max(16384).default(1500),
    }),
    run: async (p, i) => (await graph()).sliceGraph(p, i.id, i),
  },
  {
    cli: "stats",
    name: "graph_stats",
    feature: "graph",
    resource: "store",
    args: [],
    description:
      "Read indexed Evidence identity, input digest, coverage and graph counts.",
    input: z.strictObject({}),
    run: async (p) => (await graph()).graphStats(p),
  },
  {
    cli: "trace",
    name: "runtime_events",
    feature: "runtime",
    resource: "trace",
    args: [],
    description:
      "Read the next page of marks, measures and resource samples emitted by the selected application.",
    input: z.strictObject({
      cursor: z.string().min(1).max(1024).optional(),
      limit: z.int().min(1).max(250).default(25),
      wait_ms: z.int().min(0).max(10000).default(0),
    }),
    run: async (p, i, signal) =>
      (await import("./runtime.mjs")).runtimeEvents(p, i, signal),
  },
  {
    cli: "explain-js",
    name: "js_constants",
    feature: "recovery",
    resource: "script",
    args: [],
    description:
      "Report static literal expressions and their values with UTF-16 source offsets.",
    input: z.strictObject({ ...pages }),
    run: async (p, i) => (await recovery()).explainConstants(p, i),
  },
  {
    cli: "source-position",
    name: "source_position",
    feature: "recovery",
    resource: "map",
    args: [],
    description:
      "Resolve a generated line and column using the selected local build map and show a source excerpt.",
    input: z.strictObject({
      line: z.int().min(1),
      column: z.int().min(0),
      ...pages,
    }),
    run: async (p, i, signal) => (await recovery()).mapPosition(p, i, signal),
  },
  {
    cli: "r8-symbol",
    name: "r8_symbol",
    feature: "recovery",
    resource: "mapping",
    args: ["class_name"],
    description:
      "Look up a class or method in the selected R8/ProGuard mapping, retaining candidate ranges and overloads.",
    input: z.strictObject({
      class_name: text,
      method: text.optional(),
      line: z.int().min(0).optional(),
      ...pages,
    }),
    run: async (p, i) => (await recovery()).mappedSymbol(p, i),
  },
];
export async function runOperation(op, path, args, signal) {
  account(op.feature);
  const input = op.input.parse(args);
  return op.run(path, input, signal);
}
