// One entry point for every supported model file. It reads descriptors only,
// counts each byte it reads, and reports partial coverage instead of guessing.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  BudgetError,
  FormatError,
  LIMITS,
  UnsupportedError,
  u64,
} from "./errors.mjs";
import { parseJson } from "./json.mjs";
import { Issues } from "./report.mjs";
import { LocalSource } from "./source.mjs";
import { looksLikeSafetensors, readSafetensors } from "./safetensors.mjs";
import { looksLikeGguf, readGguf } from "./gguf.mjs";
import { looksLikeOnnx, readOnnx } from "./onnx.mjs";

export const SCHEMA = "rea.weights.inventory/v1";

const readers = [
  {
    format: "gguf",
    detect: (head) => looksLikeGguf(head),
    extension: /\.gguf$/i,
    read: readGguf,
  },
  {
    format: "safetensors",
    detect: looksLikeSafetensors,
    extension: /\.safetensors$/i,
    read: readSafetensors,
  },
  // Protobuf has no magic number; an .onnx name selects this reader.
  {
    format: "onnx",
    detect: looksLikeOnnx,
    extension: /\.onnx$/i,
    read: readOnnx,
  },
];

/** Register another format reader (used by optional format modules). */
export function registerReader(reader) {
  if (!readers.some((r) => r.format === reader.format)) readers.push(reader);
}

/** Inspect one local file, or a sharded safetensors index and its siblings. */
export async function inspectFile(
  path,
  { signal, limits: base = LIMITS, hash = false, strict = false } = {},
) {
  const limits = strict ? { ...base, onnx: { ...base.onnx, strict } } : base;
  if (/\.index\.json$/i.test(path))
    return inspectShardIndex(path, { signal, limits, hash });
  const source = await LocalSource.open(path, { signal });
  try {
    return await inspectSource(source, { limits, hash });
  } finally {
    await source.close();
  }
}

/** Inspect an already-open positional source. */
export async function inspectSource(
  source,
  { limits = LIMITS, hash = false, hint } = {},
) {
  const issues = new Issues();
  const report = {
    schema: SCHEMA,
    format: "unknown",
    file: { name: source.name, size: source.size },
    complete: false,
  };
  const ctx = { report, issues, limits, lastVerified: null };
  try {
    const head = source.size
      ? await source.read(0, Math.min(9, source.size))
      : Buffer.alloc(0);
    // Content decides first; a matching extension selects the reader whose
    // violations should be reported when the magic is damaged.
    const reader =
      readers.find((r) => r.format === hint) ??
      readers.find((r) => r.detect(head, source.size)) ??
      readers.find((r) => r.extension?.test(source.name));
    if (!reader)
      throw new UnsupportedError(
        "UNRECOGNIZED_FORMAT",
        "File is not a recognized safetensors, GGUF or ONNX model file",
        0,
      );
    await reader.read(source, ctx);
    ctx.descriptorReads = source.ranges.length;
    if (hash) report.file.sha256 = await fullHash(source);
    await source.verify();
  } catch (error) {
    if (error instanceof BudgetError || error instanceof UnsupportedError) {
      report.complete = false;
      report.incomplete = {
        reason: error.code,
        message: error.message,
        at: error.at,
        last_verified: ctx.lastVerified,
      };
    } else if (error instanceof FormatError) {
      report.complete = false;
      issues.error(error.code, error.message, error.at);
      if (ctx.lastVerified) report.last_verified = ctx.lastVerified;
    } else throw error;
  }
  issues.attach(report);
  report.reads = usage(source, report, ctx);
  return report;
}

/**
 * Bytes read inside the payload: the data region of safetensors and GGUF, or
 * the payload fields an ONNX reader skipped. A hashing pass is reported apart.
 */
function usage(source, report, ctx) {
  const dataStart = report.header?.data_start ?? report.data?.data_start;
  const payload =
    ctx.payloadRanges ??
    (dataStart !== undefined ? [[dataStart, source.size]] : []);
  const reads = source.ranges.slice(
    0,
    ctx.descriptorReads ?? source.ranges.length,
  );
  return {
    ...source.usage(),
    payload_bytes_read: overlap(reads, payload),
    ...(report.file.sha256 ? { hashing_pass_bytes: source.size } : {}),
  };
}

function overlap(a, b) {
  const merge = (ranges) => {
    const out = [];
    for (const [s, e] of [...ranges].sort((x, y) => x[0] - y[0])) {
      const last = out.at(-1);
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  };
  const x = merge(a);
  const y = merge(b);
  let total = 0;
  for (let i = 0, j = 0; i < x.length && j < y.length;) {
    total += Math.max(
      0,
      Math.min(x[i][1], y[j][1]) - Math.max(x[i][0], y[j][0]),
    );
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return total;
}

/** A full read establishes the file digest; header inspection never does. */
async function fullHash(source) {
  const digest = createHash("sha256");
  const chunk = 4 << 20;
  for (let at = 0; at < source.size; at += chunk)
    digest.update(await source.read(at, Math.min(chunk, source.size - at)));
  return digest.digest("hex");
}

const shardName = /^[^/\\\0]+$/;

/** A model.safetensors.index.json maps tensor names to sibling shard files. */
export async function inspectShardIndex(
  path,
  { signal, limits = LIMITS, hash = false } = {},
) {
  const issues = new Issues();
  const index = await LocalSource.open(path, { signal });
  const report = {
    schema: SCHEMA,
    format: "safetensors-sharded",
    file: { name: index.name, size: index.size },
    complete: false,
  };
  let map;
  try {
    if (index.size > limits.indexBytes)
      throw new BudgetError(
        "INDEX_BUDGET",
        `Index of ${index.size} bytes exceeds ${limits.indexBytes}`,
        0,
      );
    const parsed = parseJson(await index.read(0, index.size));
    await index.verify();
    map = parsed?.weight_map;
    if (
      !map ||
      typeof map !== "object" ||
      Array.isArray(map) ||
      Object.values(map).some((v) => typeof v !== "string")
    )
      throw new FormatError(
        "INDEX_INVALID",
        "weight_map must map tensor names to shard file names",
        0,
      );
    if (
      parsed.metadata &&
      typeof parsed.metadata === "object" &&
      typeof parsed.metadata.total_size === "bigint"
    )
      report.declared_total_size = u64(parsed.metadata.total_size);
  } catch (error) {
    await index.close();
    if (error instanceof FormatError) {
      issues.error(error.code, error.message, error.at);
      return issues.attach(report);
    }
    if (error instanceof BudgetError) {
      report.incomplete = {
        reason: error.code,
        message: error.message,
        at: error.at,
        last_verified: null,
      };
      return issues.attach(report);
    }
    throw error;
  }
  await index.close();
  const files = [...new Set(Object.values(map))].sort();
  if (files.length > limits.shards) {
    report.incomplete = {
      reason: "SHARD_BUDGET",
      message: `Index names ${files.length} shards; the limit is ${limits.shards}`,
      last_verified: null,
    };
    return issues.attach(report);
  }
  const shards = [];
  const owners = new Map();
  const tensors = [];
  let complete = true;
  let bytes = 0n;
  const reads = { requests: 1, bytes_read: index.size, payload_bytes_read: 0 };
  for (const file of files) {
    if (!shardName.test(file) || file === "." || file === "..") {
      issues.error(
        "SHARD_OUTSIDE_ROOT",
        `Shard ${JSON.stringify(file)} is not a plain sibling file name`,
      );
      complete = false;
      continue;
    }
    let shard;
    try {
      shard = await inspectFile(join(dirname(path), file), {
        signal,
        limits,
        hash,
      });
    } catch (error) {
      if (
        error.code !== "ENOENT" &&
        error.code !== "EISDIR" &&
        error.code !== "ENOTFILE"
      )
        throw error;
      issues.error(
        "MISSING_SHARD",
        `Shard ${file} is not a regular file next to the index (${error.code})`,
      );
      complete = false;
      continue;
    }
    if (shard.format !== "safetensors")
      issues.error(
        "SHARD_FORMAT",
        `Shard ${file} is ${shard.format}, not safetensors`,
      );
    complete &&= shard.complete;
    for (const key of ["requests", "bytes_read", "payload_bytes_read"])
      reads[key] += shard.reads[key];
    shards.push({
      name: file,
      size: shard.file.size,
      complete: shard.complete,
      valid: shard.valid,
      tensor_count: shard.tensor_count ?? 0,
      header_sha256: shard.header?.header_sha256,
      ...(shard.file.sha256 ? { sha256: shard.file.sha256 } : {}),
      ...(shard.incomplete ? { incomplete: shard.incomplete } : {}),
      issues: shard.issues,
    });
    for (const t of shard.tensors ?? []) {
      const previous = owners.get(t.name);
      if (previous)
        issues.error(
          "CONFLICTING_TENSOR",
          `Tensor ${t.name} is stored in both ${previous} and ${file}`,
          undefined,
          t.name,
        );
      else owners.set(t.name, file);
      if (map[t.name] === undefined)
        issues.error(
          "UNMAPPED_TENSOR",
          `Tensor ${t.name} in ${file} is absent from weight_map`,
          t.descriptor[0],
          t.name,
        );
      else if (map[t.name] !== file)
        issues.error(
          "MISMAPPED_TENSOR",
          `weight_map places ${t.name} in ${map[t.name]}; it is stored in ${file}`,
          t.descriptor[0],
          t.name,
        );
      if (t.bytes !== undefined) bytes += BigInt(t.bytes);
      tensors.push({ ...t, shard: file });
    }
  }
  for (const [name, file] of Object.entries(map))
    if (!owners.has(name) && shards.some((s) => s.name === file && s.complete))
      issues.error(
        "MISSING_TENSOR",
        `weight_map places ${name} in ${file}, which does not declare it`,
        undefined,
        name,
      );
  if (
    report.declared_total_size !== undefined &&
    complete &&
    BigInt(report.declared_total_size) !== bytes
  )
    issues.warn(
      "TOTAL_SIZE_MISMATCH",
      `metadata.total_size is ${report.declared_total_size}; shard tensors hold ${bytes} bytes`,
    );
  Object.assign(report, {
    complete,
    shards,
    tensor_count: tensors.length,
    tensor_bytes: u64(bytes),
    tensors,
    reads,
  });
  if (!complete && !report.incomplete)
    report.incomplete = {
      reason: "SHARDS_INCOMPLETE",
      message: "At least one shard was missing, invalid or incomplete",
      last_verified: null,
    };
  return issues.attach(report);
}
