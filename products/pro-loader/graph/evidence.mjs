// Select records by their structural JSON path. The full artifact graph and raw
// result can be much larger than the semantic graph and never enter the assembler.
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import Assembler from "stream-json/assembler.js";
import parser from "stream-json/parser.js";
import {
  compactNode,
  compactRelation,
} from "../../slicer/src/index-evidence.mjs";

const rows = Symbol("array items");
const levels = Symbol("native graph levels");
const MAX_RECORD = 8 * 1024 * 1024;
const MAX_DEPTH = 256;

export async function visitEvidence(
  path,
  onNode,
  onEdge,
  { projectNode = compactNode, extensionCoverage } = {},
) {
  const meta = {};
  const shapes = new Set();
  const limitations = [];
  let limitationCount = 0;
  const set = (key) => (value) => {
    if (Object.hasOwn(meta, key))
      throw new Error(`Duplicate Evidence field ${key}`);
    meta[key] = value;
  };
  const collection = (name, consume) => ({ name, [rows]: consume });
  const schema = {
    operation: set("operation"),
    evidence_id: set("evidence_id"),
    subject: {
      name: set("subject"),
      format: set("subject_format"),
      digest: { sha256: set("subject_sha256") },
    },
    parameters: { direction: set("direction") },
    normalized_result: {
      limitations: collection("limitations", (value) => {
        if (typeof value === "string") {
          if (limitationCount < 10) limitations.push(value.slice(0, 512));
          limitationCount++;
        }
      }),
      semantic_graph: {
        coverage: {
          status: set("coverage"),
          truncated: set("source_truncated"),
          omitted_nodes: set("source_omitted_nodes"),
          omitted_relations: set("source_omitted_relations"),
        },
        nodes: collection("nodes", (row) => onNode(projectNode(row))),
        relations: collection("relations", (row) =>
          onEdge({ ...compactRelation(row), ref: row.relation_id }),
        ),
      },
      graph: {
        [levels]: collection("native-level", (row) => {
          if (
            typeof row?.address !== "string" ||
            !["ok", "error"].includes(row.status)
          )
            throw new Error("Invalid native relationship record");
          onNode({
            id: row.address,
            kind: "procedure",
            label: row.address,
            module: null,
            line: null,
            column: null,
            properties: {
              status: row.status,
              coverage: row.relationship_coverage ?? null,
              ...(row.error ? { error: row.error } : {}),
              ...(row.limitations ? { limitations: row.limitations } : {}),
            },
          });
          if (row.status === "ok") {
            if (!Array.isArray(row.calls))
              throw new Error("Invalid native calls");
            for (const called of row.calls)
              onEdge({
                source: row.address,
                target: called,
                relation: "calls",
                resolution: "reported",
              });
          }
        }),
      },
    },
  };

  const stack = [];
  let record;
  let scalarParts;
  let scalarSize;
  // Only pack selected string values. A large ignored raw_result is discarded chunk by chunk.
  const childRoute = () => {
    if (stack.length === 0) return schema;
    const frame = stack.at(-1);
    if (frame.array) return frame.route?.[rows];
    if (Object.hasOwn(frame.route ?? {}, frame.key))
      return frame.route[frame.key];
    if (frame.route?.[levels] && /^\d+$/.test(frame.key))
      return frame.route[levels];
  };
  const accept = (token) => {
    const { name, value } = token;
    if (name === "startString") {
      const route = childRoute();
      scalarParts = record || typeof route === "function" ? [] : undefined;
      scalarSize = 0;
      return;
    }
    if (name === "stringChunk") {
      if (scalarParts) {
        scalarSize += value.length;
        if (scalarSize > MAX_RECORD)
          throw new Error("Evidence string exceeds the 8 MiB record limit");
        scalarParts.push(value);
      }
      return;
    }
    if (name === "endString") {
      if (scalarParts)
        accept({ name: "stringValue", value: scalarParts.join("") });
      scalarParts = undefined;
      return;
    }
    if (record) {
      record.size += typeof value === "string" ? value.length + 8 : 8;
      if (record.size > MAX_RECORD || record.assembler.depth > MAX_DEPTH)
        throw new Error(
          "Selected Evidence record exceeds its size or depth limit",
        );
      record.assembler.consume(token);
      if (record.assembler.done) {
        record.consume(record.assembler.current);
        record = undefined;
      }
      return;
    }
    if (name === "keyValue") {
      stack.at(-1).key = value;
      return;
    }
    if (name === "endArray" || name === "endObject") {
      stack.pop();
      return;
    }
    const route = childRoute();
    if (typeof route === "function") {
      record = { assembler: new Assembler(), consume: route, size: 0 };
      accept(token);
    } else if (name === "startObject" || name === "startArray") {
      const array = name === "startArray";
      if (route && array !== Boolean(route[rows]))
        throw new Error("Unexpected Evidence container");
      if (route?.[rows]) {
        if (route.name !== "native-level" && shapes.has(route.name))
          throw new Error(`Duplicate Evidence collection ${route.name}`);
        shapes.add(route.name);
      }
      if (stack.length >= MAX_DEPTH)
        throw new Error("Evidence nesting exceeds 256 levels");
      stack.push({ route, array, key: null });
    } else if (route) throw new Error("Expected an Evidence object or array");
  };

  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Expected a regular Evidence file");
    const hash = createHash("sha256");
    const source = file.createReadStream({ autoClose: false });
    await pipeline(
      source,
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      parser.asStream({
        streamValues: false,
        streamStrings: true,
        packStrings: false,
      }),
      new Writable({
        objectMode: true,
        write(token, _, done) {
          try {
            accept(token);
            done();
          } catch (error) {
            done(error);
          }
        },
      }),
    );
    const after = await file.stat({ bigint: true });
    if (before.ctimeNs !== after.ctimeNs || before.size !== after.size)
      throw new Error("Evidence changed during indexing");
    if (typeof meta.evidence_id !== "string" || !meta.evidence_id.length)
      throw new Error("Missing Evidence ID");
    const js =
      meta.operation === "analyze_javascript_application" &&
      shapes.has("nodes") &&
      shapes.has("relations") &&
      !shapes.has("native-level");
    const native =
      meta.operation === "get_call_graph" &&
      shapes.has("native-level") &&
      !shapes.has("nodes") &&
      ["forward", "backward"].includes(meta.direction ?? "forward");
    const coverage = js
      ? "unknown"
      : native
        ? "per-procedure"
        : extensionCoverage?.(meta, shapes);
    if (!coverage)
      throw new Error(
        "Expected JavaScript application or native get_call_graph Evidence",
      );
    return {
      ...meta,
      coverage: meta.coverage ?? coverage,
      ...(limitationCount
        ? { limitations, limitation_count: limitationCount }
        : {}),
      input_sha256: hash.digest("hex"),
      input_bytes: Number(before.size),
    };
  } finally {
    await file.close();
  }
}
