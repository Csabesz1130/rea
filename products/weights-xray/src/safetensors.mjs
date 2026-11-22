// Safetensors: an eight-byte little-endian header length, a UTF-8 JSON object
// of tensor descriptors, then the data region. Offsets are half-open intervals
// relative to the data region. https://github.com/safetensors/safetensors#format
import { parseJson } from "./json.mjs";
import { BudgetError, FormatError, u64 } from "./errors.mjs";
import { sha256 } from "./source.mjs";
import { metadataValue } from "./report.mjs";

// Bits per element, pinned to the safetensors Dtype enum.
export const SAFETENSORS_DTYPES = Object.freeze({
  BOOL: 8,
  U8: 8,
  I8: 8,
  F8_E5M2: 8,
  F8_E4M3: 8,
  F8_E8M0: 8,
  I16: 16,
  U16: 16,
  F16: 16,
  BF16: 16,
  I32: 32,
  U32: 32,
  F32: 32,
  I64: 64,
  U64: 64,
  F64: 64,
  C64: 64,
  F4: 4,
  F6_E2M3: 6,
  F6_E3M2: 6,
});

const isU64 = (v) => typeof v === "bigint" && v >= 0n && v < 1n << 64n;

/** Detect a safetensors header from the first nine bytes. */
export function looksLikeSafetensors(head, size) {
  if (head.length < 9 || head[8] !== 0x7b) return false;
  const n = head.readBigUInt64LE(0);
  return n >= 2n && n <= BigInt(size - 8);
}

/** Read the descriptors of one safetensors file into `ctx.report`. */
export async function readSafetensors(source, ctx) {
  const { report, issues, limits } = ctx;
  report.format = "safetensors";
  if (source.size < 8)
    throw new FormatError(
      "HEADER_TOO_SHORT",
      "File is shorter than the eight-byte header length",
      0,
    );
  const declared = (await source.read(0, 8)).readBigUInt64LE(0);
  if (declared > BigInt(source.size - 8))
    throw new FormatError(
      "HEADER_LENGTH_EXCEEDS_FILE",
      `Header length ${declared} passes the end of the file`,
      0,
    );
  const length = Number(declared);
  const dataStart = 8 + length;
  report.header = {
    json_bytes: length,
    data_start: dataStart,
    data_bytes: source.size - dataStart,
  };
  if (length > limits.metadataBytes)
    throw new BudgetError(
      "METADATA_BUDGET",
      `Header of ${length} bytes exceeds the ${limits.metadataBytes}-byte metadata budget`,
      0,
    );
  const bytes = await source.read(8, length);
  report.header.header_sha256 = sha256(bytes);
  if (bytes[0] !== 0x7b)
    throw new FormatError("HEADER_NOT_OBJECT", "Header must begin with '{'", 8);
  const spans = new Map();
  const header = parseJson(bytes, {
    base: 8,
    onRootEntry: (key, start, end) => spans.set(key, [start, end]),
  });
  if (header === null || typeof header !== "object" || Array.isArray(header))
    throw new FormatError(
      "HEADER_NOT_OBJECT",
      "Header is not a JSON object",
      8,
    );

  const names = Object.keys(header).filter((k) => k !== "__metadata__");
  if (names.length > limits.tensors)
    throw new BudgetError(
      "TENSOR_BUDGET",
      `Header declares ${names.length} tensors; the limit is ${limits.tensors}`,
      8,
    );
  if (Object.hasOwn(header, "__metadata__")) {
    const meta = header.__metadata__;
    const at = spans.get("__metadata__")[0];
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
      issues.error(
        "METADATA_NOT_STRING_MAP",
        "__metadata__ must be an object of strings",
        at,
      );
    } else {
      const keys = Object.keys(meta);
      if (keys.length > limits.metadataFields)
        throw new BudgetError(
          "METADATA_FIELD_BUDGET",
          `__metadata__ has ${keys.length} fields`,
          at,
        );
      report.metadata = Object.create(null);
      for (const key of keys) {
        if (typeof meta[key] !== "string")
          issues.error(
            "METADATA_NOT_STRING_MAP",
            `__metadata__.${key} is not a string`,
            at,
          );
        else report.metadata[key] = metadataValue(meta[key]);
      }
    }
  }

  const tensors = [];
  for (const name of names) {
    const info = header[name];
    const descriptor = spans.get(name);
    const bad = (code, message) =>
      issues.error(code, message, descriptor[0], name);
    if (info === null || typeof info !== "object" || Array.isArray(info)) {
      bad("TENSOR_DESCRIPTOR_INVALID", "Descriptor is not an object");
      continue;
    }
    const extra = Object.keys(info).filter(
      (k) => !["dtype", "shape", "data_offsets"].includes(k),
    );
    if (extra.length)
      bad(
        "TENSOR_DESCRIPTOR_INVALID",
        "Unknown descriptor field " + extra.join(", "),
      );
    const { dtype, shape, data_offsets: offsets } = info;
    if (typeof dtype !== "string") {
      bad("TENSOR_DESCRIPTOR_INVALID", "dtype must be a string");
      continue;
    }
    if (!Array.isArray(shape) || !shape.every(isU64)) {
      bad(
        "TENSOR_DESCRIPTOR_INVALID",
        "shape must be an array of unsigned integers",
      );
      continue;
    }
    if (shape.length > limits.dimensions) {
      bad(
        "DIMENSION_BUDGET",
        `Tensor has ${shape.length} dimensions; the limit is ${limits.dimensions}`,
      );
      continue;
    }
    if (
      !Array.isArray(offsets) ||
      offsets.length !== 2 ||
      !offsets.every(isU64)
    ) {
      bad(
        "TENSOR_DESCRIPTOR_INVALID",
        "data_offsets must be two unsigned integers",
      );
      continue;
    }
    const [begin, end] = offsets;
    const elements = shape.reduce((a, b) => a * b, 1n);
    const tensor = {
      name,
      dtype,
      shape: shape.map(u64),
      elements: u64(elements),
      data_offsets: [u64(begin), u64(end)],
      descriptor,
    };
    if (end < begin) {
      bad("OFFSETS_INVALID", "data_offsets end precedes begin");
      tensors.push(tensor);
      continue;
    }
    tensor.bytes = u64(end - begin);
    tensor.file_range = [
      u64(BigInt(dataStart) + begin),
      u64(BigInt(dataStart) + end),
    ];
    const bits = SAFETENSORS_DTYPES[dtype];
    if (bits === undefined) {
      issues.warn(
        "UNKNOWN_DTYPE",
        `dtype ${dtype} is not in the pinned safetensors table; storage size is unverified`,
        descriptor[0],
        name,
      );
      tensor.storage = "unknown";
    } else {
      const totalBits = elements * BigInt(bits);
      if (bits % 8) {
        issues.notice(
          "SUB_BYTE_LAYOUT",
          `${dtype} packs ${bits}-bit elements; layout within bytes is not interpreted`,
          descriptor[0],
          name,
        );
        tensor.packing = "sub-byte";
      }
      if (totalBits % 8n)
        bad(
          "MISALIGNED_SLICE",
          `${elements} ${dtype} elements do not fill whole bytes`,
        );
      else if (totalBits / 8n !== end - begin)
        bad(
          "SHAPE_BYTE_MISMATCH",
          `shape and dtype require ${totalBits / 8n} bytes; data_offsets span ${end - begin}`,
        );
    }
    tensors.push({ ...tensor, _begin: begin, _end: end });
  }

  // Contiguous coverage of the data region, in the reference reader's order.
  const placed = tensors.filter(
    (t) => t._begin !== undefined && t._end >= t._begin,
  );
  placed.sort((a, b) =>
    a._begin < b._begin
      ? -1
      : a._begin > b._begin
        ? 1
        : a._end < b._end
          ? -1
          : a._end > b._end
            ? 1
            : 0,
  );
  const dataBytes = BigInt(source.size - dataStart);
  let cursor = 0n;
  for (const t of placed) {
    if (t._begin > cursor)
      issues.error(
        "GAP",
        `Bytes ${cursor}..${t._begin} of the data region belong to no tensor`,
        dataStart + Number(cursor),
        t.name,
      );
    else if (t._begin < cursor)
      issues.error(
        "OVERLAP",
        `Tensor begins at ${t._begin}, inside the preceding tensor (ends ${cursor})`,
        t.descriptor[0],
        t.name,
      );
    if (t._end > dataBytes)
      issues.error(
        "DATA_OUT_OF_BOUNDS",
        `Tensor ends at ${t._end}; the data region has ${dataBytes} bytes`,
        t.descriptor[0],
        t.name,
      );
    if (t._end > cursor) cursor = t._end;
  }
  if (cursor < dataBytes)
    issues.error(
      "TRAILING_DATA",
      `${dataBytes - cursor} bytes after the last tensor belong to no tensor`,
      dataStart + Number(cursor),
    );

  let parameters = 0n;
  const dtypes = Object.create(null);
  for (const t of tensors) {
    delete t._begin;
    delete t._end;
    parameters += BigInt(t.elements);
    const d = (dtypes[t.dtype] ??= { tensors: 0, bytes: 0n });
    d.tensors++;
    if (t.bytes !== undefined) d.bytes += BigInt(t.bytes);
  }
  for (const d of Object.values(dtypes)) d.bytes = u64(d.bytes);
  tensors.sort((a, b) => a.descriptor[0] - b.descriptor[0]);
  Object.assign(report, {
    complete: true,
    tensor_count: tensors.length,
    parameters: u64(parameters),
    dtypes,
    tensors,
    coverage: {
      descriptor_bytes: [0, dataStart],
      data_bytes_covered: u64(cursor > dataBytes ? dataBytes : cursor),
    },
  });
}
