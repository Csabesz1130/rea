import { z } from "zod";

const text = z.string().min(1).max(2048);
export const graphSearchInput = z.strictObject({
  query: text,
  kind: text.optional(),
  mode: z.enum(["auto", "exact", "semantic"]).default("auto"),
  limit: z.int().min(1).max(100).default(10),
  offset: z.int().min(0).default(0),
});
export const graphSliceInput = z.strictObject({
  id: text,
  evidence_id: text.optional(),
  hops: z.int().min(0).max(12).default(2),
  direction: z.enum(["both", "in", "out"]).default("both"),
  relation: text.optional(),
  budget: z.int().min(64).max(16384).default(1500),
});
export const graphStatsInput = z.strictObject({});
