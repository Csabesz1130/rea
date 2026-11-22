// GGUF v2/v3, little-endian: magic, version, tensor and key/value counts,
// typed metadata, tensor descriptors, then an aligned data section.
// https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
import { createHash } from "node:crypto";
import { BudgetError, FormatError, UnsupportedError, u64 } from "./errors.mjs";
import { Cursor } from "./source.mjs";
import { metadataValue } from "./report.mjs";

// [name, elements per block, bytes per block], pinned to gguf-py 0.19.0
// GGML_QUANT_SIZES. Q8_1 is omitted: it is a dot-product intermediate and the
// Python table (40 bytes) disagrees with ggml's block_q8_1 struct (36 bytes).
export const GGML_TYPES = Object.freeze({
  0: ["F32", 1, 4],
  1: ["F16", 1, 2],
  2: ["Q4_0", 32, 18],
  3: ["Q4_1", 32, 20],
  6: ["Q5_0", 32, 22],
  7: ["Q5_1", 32, 24],
  8: ["Q8_0", 32, 34],
  9: ["Q8_1", 32, null],
  10: ["Q2_K", 256, 84],
  11: ["Q3_K", 256, 110],
  12: ["Q4_K", 256, 144],
  13: ["Q5_K", 256, 176],
  14: ["Q6_K", 256, 210],
  15: ["Q8_K", 256, 292],
  16: ["IQ2_XXS", 256, 66],
  17: ["IQ2_XS", 256, 74],
  18: ["IQ3_XXS", 256, 98],
  19: ["IQ1_S", 256, 50],
  20: ["IQ4_NL", 32, 18],
  21: ["IQ3_S", 256, 110],
  22: ["IQ2_S", 256, 82],
  23: ["IQ4_XS", 256, 136],
  24: ["I8", 1, 1],
  25: ["I16", 1, 2],
  26: ["I32", 1, 4],
  27: ["I64", 1, 8],
  28: ["F64", 1, 8],
  29: ["IQ1_M", 256, 56],
  30: ["BF16", 1, 2],
  34: ["TQ1_0", 256, 54],
  35: ["TQ2_0", 256, 66],
  39: ["MXFP4", 32, 17],
  40: ["NVFP4", 64, 36],
  41: ["Q1_0", 128, 18],
});

// llama_ftype values of general.file_type, pinned to gguf-py 0.19.0 LlamaFileType.
const FILE_TYPES = {
  0: "ALL_F32",
  1: "MOSTLY_F16",
  2: "MOSTLY_Q4_0",
  3: "MOSTLY_Q4_1",
  7: "MOSTLY_Q8_0",
  8: "MOSTLY_Q5_0",
  9: "MOSTLY_Q5_1",
  10: "MOSTLY_Q2_K",
  11: "MOSTLY_Q3_K_S",
  12: "MOSTLY_Q3_K_M",
  13: "MOSTLY_Q3_K_L",
  14: "MOSTLY_Q4_K_S",
  15: "MOSTLY_Q4_K_M",
  16: "MOSTLY_Q5_K_S",
  17: "MOSTLY_Q5_K_M",
  18: "MOSTLY_Q6_K",
  19: "MOSTLY_IQ2_XXS",
  20: "MOSTLY_IQ2_XS",
  21: "MOSTLY_Q2_K_S",
  22: "MOSTLY_IQ3_XS",
  23: "MOSTLY_IQ3_XXS",
  24: "MOSTLY_IQ1_S",
  25: "MOSTLY_IQ4_NL",
  26: "MOSTLY_IQ3_S",
  27: "MOSTLY_IQ3_M",
  28: "MOSTLY_IQ2_S",
  29: "MOSTLY_IQ2_M",
  30: "MOSTLY_IQ4_XS",
  31: "MOSTLY_IQ1_M",
  32: "MOSTLY_BF16",
  36: "MOSTLY_TQ1_0",
  37: "MOSTLY_TQ2_0",
  38: "MOSTLY_MXFP4_MOE",
  39: "MOSTLY_NVFP4",
  40: "MOSTLY_Q1_0",
  1024: "GUESSED",
};

const VALUE_TYPES = [
  "UINT8",
  "INT8",
  "UINT16",
  "INT16",
  "UINT32",
  "INT32",
  "FLOAT32",
  "BOOL",
  "STRING",
  "ARRAY",
  "UINT64",
  "INT64",
  "FLOAT64",
];
const FIXED = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8,
};
// Smallest encoding of a value of each type: a string is its length prefix,
// an array its element type and count.
const MIN = { ...FIXED, 8: 8, 9: 12 };
const MIN_KV = 8 + 4 + 1; // empty key, value type, one-byte value
const MIN_TENSOR = 8 + 4 + 4 + 8; // empty name, no dimensions, type, offset
const PREVIEW = 8;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export const looksLikeGguf = (head) =>
  head.length >= 4 && head.toString("latin1", 0, 4) === "GGUF";

function scalar(type, b) {
  switch (type) {
    case 0:
      return b.readUInt8(0);
    case 1:
      return b.readInt8(0);
    case 2:
      return b.readUInt16LE(0);
    case 3:
      return b.readInt16LE(0);
    case 4:
      return b.readUInt32LE(0);
    case 5:
      return b.readInt32LE(0);
    case 6:
      return b.readFloatLE(0);
    case 10:
      return u64(b.readBigUInt64LE(0));
    case 11:
      return u64(b.readBigInt64LE(0));
    case 12:
      return b.readDoubleLE(0);
  }
}

/** Read the descriptors of one GGUF file into `ctx.report`. */
export async function readGguf(source, ctx) {
  const { report, issues, limits } = ctx;
  report.format = "gguf";
  const cur = new Cursor(source, { limit: limits.metadataBytes });
  cur.reserve = () => 0;
  if (source.size < 24) {
    if (source.size >= 4 && !looksLikeGguf(await cur.bytes(4)))
      throw new FormatError("BAD_MAGIC", "File does not begin with GGUF", 0);
    throw new FormatError(
      "TRUNCATED",
      "File is shorter than the 24-byte GGUF header",
      0,
    );
  }
  const fixed = await cur.bytes(24);
  if (!looksLikeGguf(fixed))
    throw new FormatError("BAD_MAGIC", "File does not begin with GGUF", 0);
  const version = fixed.readUInt32LE(4);
  if (version !== 2 && version !== 3) {
    if (fixed.readUInt32BE(4) === 2 || fixed.readUInt32BE(4) === 3)
      throw new UnsupportedError(
        "BIG_ENDIAN_UNSUPPORTED",
        "Big-endian GGUF is not supported",
        4,
      );
    throw new UnsupportedError(
      "UNSUPPORTED_VERSION",
      `GGUF version ${version} is not supported; versions 2 and 3 are`,
      4,
    );
  }
  report.version = version;
  const tensorCount = fixed.readBigUInt64LE(8);
  const kvCount = fixed.readBigUInt64LE(16);
  if (kvCount > BigInt(limits.metadataFields))
    throw new BudgetError(
      "METADATA_FIELD_BUDGET",
      `File declares ${kvCount} metadata fields; the limit is ${limits.metadataFields}`,
      16,
    );
  if (tensorCount > BigInt(limits.tensors))
    throw new BudgetError(
      "TENSOR_BUDGET",
      `File declares ${tensorCount} tensors; the limit is ${limits.tensors}`,
      8,
    );
  report.declared = {
    tensors: Number(tensorCount),
    metadata_fields: Number(kvCount),
  };
  // Each frame holds the minimum encoded size of the items that follow the
  // current one at its level, so buffered reads stop before the data section.
  const frames = [0];
  cur.reserve = () => frames.reduce((a, b) => a + b, 0);

  let elements = 0;
  const string = async (field) => {
    const at = cur.pos;
    const length = await cur.u64();
    if (length > BigInt(limits.stringBytes))
      throw new BudgetError(
        "STRING_BUDGET",
        `${field} declares a ${length}-byte string`,
        at,
      );
    const bytes = await cur.bytes(Number(length));
    try {
      return utf8.decode(bytes);
    } catch {
      throw new FormatError("INVALID_UTF8", `${field} is not valid UTF-8`, at);
    }
  };
  const value = async (type, depth, field) => {
    if (type === 8) return string(field);
    if (type === 7) {
      const b = await cur.u8();
      if (b > 1)
        throw new FormatError(
          "INVALID_BOOL",
          `${field} has boolean byte ${b}`,
          cur.pos - 1,
        );
      return b === 1;
    }
    if (type === 9) {
      if (depth >= limits.arrayDepth)
        throw new BudgetError(
          "ARRAY_DEPTH_BUDGET",
          `${field} nests arrays deeper than ${limits.arrayDepth}`,
          cur.pos,
        );
      const start = cur.pos;
      const elementType = await cur.u32();
      const length = await cur.u64();
      if (BigInt(elements) + length > BigInt(limits.arrayElements))
        throw new BudgetError(
          "ARRAY_BUDGET",
          `Arrays exceed ${limits.arrayElements} elements in total at ${field}`,
          start,
        );
      if (VALUE_TYPES[elementType] === undefined)
        throw new FormatError(
          "UNKNOWN_VALUE_TYPE",
          `${field} has array element type ${elementType}`,
          start,
        );
      const n = Number(length);
      elements += n;
      // The digest covers the encoded element bytes exactly as stored.
      const digest = createHash("sha256");
      const preview = [];
      cur.taps.add(digest);
      const frame = frames.push(0) - 1;
      try {
        if (FIXED[elementType] && elementType !== 7) {
          const size = FIXED[elementType];
          for (let done = 0; done < n;) {
            const take = Math.min(n - done, 65536);
            frames[frame] = (n - done - take) * size;
            const chunk = await cur.bytes(take * size);
            for (let k = 0; k < take && preview.length < PREVIEW; k++)
              preview.push(
                scalar(elementType, chunk.subarray(k * size, (k + 1) * size)),
              );
            done += take;
          }
        } else {
          for (let k = 0; k < n; k++) {
            frames[frame] = (n - k - 1) * MIN[elementType];
            const item = await value(elementType, depth + 1, `${field}[${k}]`);
            if (preview.length < PREVIEW)
              preview.push(elementType === 8 ? metadataValue(item) : item);
          }
        }
      } finally {
        frames.pop();
        cur.taps.delete(digest);
      }
      return {
        type: "array",
        element_type: VALUE_TYPES[elementType],
        length: n,
        ...(n > PREVIEW
          ? { preview, sha256: digest.digest("hex") }
          : { values: preview }),
      };
    }
    const size = FIXED[type];
    if (size === undefined)
      throw new FormatError(
        "UNKNOWN_VALUE_TYPE",
        `${field} has value type ${type}`,
        cur.pos - 4,
      );
    return scalar(type, await cur.bytes(size));
  };

  const metadata = Object.create(null);
  const types = Object.create(null);
  const raw = Object.create(null);
  report.metadata = metadata;
  for (let k = 0n; k < kvCount; k++) {
    frames[0] =
      Number(kvCount - k - 1n) * MIN_KV + Number(tensorCount) * MIN_TENSOR;
    const at = cur.pos;
    const key = await string("metadata key");
    if (Object.hasOwn(metadata, key))
      throw new FormatError(
        "DUPLICATE_KEY",
        `Duplicate metadata key ${JSON.stringify(key)}`,
        at,
      );
    const typeAt = cur.pos;
    const type = await cur.u32();
    if (VALUE_TYPES[type] === undefined)
      throw new FormatError(
        "UNKNOWN_VALUE_TYPE",
        `${key} has value type ${type}`,
        typeAt,
      );
    const v = await value(type, 0, key);
    raw[key] = v;
    types[key] = VALUE_TYPES[type];
    metadata[key] = typeof v === "string" ? metadataValue(v) : v;
    ctx.lastVerified = { metadata: key, end: cur.pos };
  }
  report.metadata_types = types;

  let alignment = 32;
  if (Object.hasOwn(raw, "general.alignment")) {
    const a = raw["general.alignment"];
    if (
      types["general.alignment"] !== "UINT32" ||
      !Number.isInteger(a) ||
      a <= 0 ||
      a % 8
    )
      issues.error(
        "ALIGNMENT_INVALID",
        "general.alignment must be a positive UINT32 multiple of 8; using 32",
        undefined,
      );
    else alignment = a;
  }
  report.alignment = alignment;

  const tensors = [];
  report.tensors = tensors;
  const names = new Set();
  for (let t = 0n; t < tensorCount; t++) {
    frames[0] = Number(tensorCount - t - 1n) * MIN_TENSOR;
    const start = cur.pos;
    const name = await string("tensor name");
    const nDims = await cur.u32();
    if (nDims > limits.ggufDimensions)
      throw new FormatError(
        "TOO_MANY_DIMS",
        `${name} declares ${nDims} dimensions; GGUF allows ${limits.ggufDimensions}`,
        start,
      );
    const dims = [];
    for (let d = 0; d < nDims; d++) dims.push(await cur.u64());
    const typeId = await cur.u32();
    const offset = await cur.u64();
    const descriptor = [start, cur.pos];
    if (names.has(name))
      issues.error(
        "DUPLICATE_TENSOR",
        `Tensor ${name} is declared twice`,
        start,
        name,
      );
    names.add(name);
    const known = GGML_TYPES[typeId];
    const n = dims.reduce((a, b) => a * b, 1n);
    const tensor = {
      name,
      type: known ? known[0] : `UNKNOWN_${typeId}`,
      type_id: typeId,
      shape: dims.map(u64),
      elements: u64(n),
      offset: u64(offset),
      descriptor,
    };
    if (!known || known[2] === null) {
      issues.warn(
        "UNKNOWN_GGML_TYPE",
        `GGML type ${typeId} has no pinned storage size; its extent is unverified`,
        start,
        name,
      );
      tensor.storage = "unknown";
    } else {
      const [, block, bytesPerBlock] = known;
      const row = dims.length ? dims[0] : 1n;
      if (row % BigInt(block)) {
        issues.error(
          "ROW_NOT_DIVISIBLE",
          `First dimension ${row} is not a multiple of the ${known[0]} block size ${block}`,
          start,
          name,
        );
        tensor.storage = "invalid";
      } else tensor._bytes = (n / BigInt(block)) * BigInt(bytesPerBlock);
    }
    if (offset % BigInt(alignment))
      issues.error(
        "OFFSET_MISALIGNED",
        `Offset ${offset} is not a multiple of the alignment ${alignment}`,
        start,
        name,
      );
    tensors.push(tensor);
    ctx.lastVerified = { tensor: name, end: cur.pos };
  }

  const infoEnd = cur.pos;
  const dataStart = Math.ceil(infoEnd / alignment) * alignment;
  report.data = {
    descriptor_end: infoEnd,
    data_start: dataStart,
    data_bytes: Math.max(0, source.size - dataStart),
  };
  if (dataStart > source.size && tensors.length)
    issues.error(
      "DATA_OUT_OF_BOUNDS",
      "The aligned data section starts after the end of the file",
      infoEnd,
    );
  const dataBytes = BigInt(Math.max(0, source.size - dataStart));
  const placed = tensors
    .filter((x) => x._bytes !== undefined)
    .sort((a, b) => (BigInt(a.offset) < BigInt(b.offset) ? -1 : 1));
  let end = 0n;
  let unreferenced = 0n;
  for (const x of placed) {
    const begin = BigInt(x.offset);
    const stop = begin + x._bytes;
    x.bytes = u64(x._bytes);
    x.file_range = [
      u64(BigInt(dataStart) + begin),
      u64(BigInt(dataStart) + stop),
    ];
    if (begin < end)
      issues.error(
        "OVERLAP",
        `Tensor begins at ${begin}, inside the preceding tensor (ends ${end})`,
        x.descriptor[0],
        x.name,
      );
    else {
      const padded =
        ((end + BigInt(alignment) - 1n) / BigInt(alignment)) *
        BigInt(alignment);
      if (begin > padded) unreferenced += begin - padded;
    }
    if (stop > dataBytes)
      issues.error(
        "DATA_OUT_OF_BOUNDS",
        `Tensor ends at ${stop}; the data section has ${dataBytes} bytes`,
        x.descriptor[0],
        x.name,
      );
    if (stop > end) end = stop;
  }
  const paddedEnd =
    ((end + BigInt(alignment) - 1n) / BigInt(alignment)) * BigInt(alignment);
  if (dataBytes > paddedEnd && placed.length === tensors.length)
    unreferenced += dataBytes - paddedEnd;
  if (unreferenced > 0n)
    issues.warn(
      "UNREFERENCED_DATA",
      `${unreferenced} bytes of the data section belong to no tensor beyond alignment padding`,
      dataStart,
    );
  for (const x of tensors) delete x._bytes;
  report.coverage = {
    descriptor_bytes: [0, infoEnd],
    data_bytes_covered: u64(end > dataBytes ? dataBytes : end),
  };
  report.complete = true;
  report.tensor_count = tensors.length;
  summarize(report, raw);
}

function summarize(report, raw) {
  const arch =
    typeof raw["general.architecture"] === "string"
      ? raw["general.architecture"]
      : null;
  const declared = Object.create(null);
  for (const key of [
    "general.name",
    "general.basename",
    "general.size_label",
    "general.license",
    "general.quantization_version",
  ])
    if (Object.hasOwn(raw, key)) declared[key] = report.metadata[key];
  if (Object.hasOwn(raw, "general.file_type")) {
    const ft = raw["general.file_type"];
    declared["general.file_type"] = FILE_TYPES[ft] ?? ft;
  }
  const hyper = Object.create(null);
  if (arch)
    for (const [key, v] of Object.entries(raw))
      if (key.startsWith(arch + "."))
        hyper[key.slice(arch.length + 1)] =
          typeof v === "string" ? report.metadata[key] : v;
  const scalarOf = (key) =>
    typeof hyper[key] === "number" ? hyper[key] : null;
  const heads = scalarOf("attention.head_count");
  const kv = scalarOf("attention.head_count_kv");
  const derived = Object.create(null);
  if (heads && kv) derived.query_heads_per_kv_head = heads / kv;
  if (hyper["attention.head_count_kv"]?.type === "array")
    derived.kv_heads_vary_by_layer = true;
  if (scalarOf("expert_count"))
    derived.mixture_of_experts = {
      experts: scalarOf("expert_count"),
      active: scalarOf("expert_used_count"),
      shared: scalarOf("expert_shared_count"),
    };
  if (scalarOf("attention.kv_lora_rank"))
    derived.latent_attention = {
      kv_lora_rank: scalarOf("attention.kv_lora_rank"),
      q_lora_rank: scalarOf("attention.q_lora_rank"),
    };
  report.architecture = {
    name: arch,
    declared,
    hyperparameters: hyper,
    derived,
  };

  const byType = Object.create(null);
  const byRole = Object.create(null);
  for (const t of report.tensors) {
    const entry = (byType[t.type] ??= { tensors: 0, bytes: 0n });
    entry.tensors++;
    if (t.bytes !== undefined) entry.bytes += BigInt(t.bytes);
    const match = /^blk\.(\d+)\.(.+)$/.exec(t.name);
    const role = match ? "blk.*." + match[2] : t.name;
    const r = (byRole[role] ??= Object.create(null));
    (r[t.type] ??= []).push(match ? Number(match[1]) : null);
  }
  for (const e of Object.values(byType)) e.bytes = u64(e.bytes);
  const mixed = [];
  for (const [role, typesForRole] of Object.entries(byRole)) {
    const list = Object.entries(typesForRole);
    if (list.length > 1)
      mixed.push({
        role,
        types: Object.fromEntries(
          list.map(([type, blocks]) => [type, ranges(blocks)]),
        ),
      });
  }
  report.quantization = {
    by_type: byType,
    by_role: Object.fromEntries(
      Object.entries(byRole).map(([role, t]) => [
        role,
        Object.fromEntries(
          Object.entries(t).map(([type, blocks]) => [type, blocks.length]),
        ),
      ]),
    ),
    mixed_roles: mixed,
  };
  report.chat_templates = Object.entries(raw)
    .filter(
      ([key, v]) =>
        typeof v === "string" && /^tokenizer\.chat_template(\.|$)/.test(key),
    )
    .map(([key, v]) => templateFacts(key, v));
}

/** Compact sorted block indices: [0,1,2,5] -> "0-2,5". */
function ranges(blocks) {
  const sorted = [...new Set(blocks.filter((b) => b !== null))].sort(
    (a, b) => a - b,
  );
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return out.join(",") || "global";
}

/** Observable facts about an embedded Jinja chat template; it is never rendered. */
export function templateFacts(key, text) {
  const statements = Object.create(null);
  for (const m of text.matchAll(/\{%[-+]?\s*([A-Za-z_]+)/g))
    statements[m[1]] = (statements[m[1]] ?? 0) + 1;
  const references = ["include", "import", "from", "extends"].filter(
    (s) => statements[s],
  );
  return {
    key,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    statements,
    ...(references.length ? { references_other_templates: references } : {}),
  };
}
