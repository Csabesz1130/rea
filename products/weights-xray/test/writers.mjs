// Minimal writers for malformed and oversized fixtures that the reference
// Python writers refuse to produce. Valid-format goldens come from
// fixtures/generate.py and the reference readers instead.
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";

/** Write a safetensors file from a raw header string and a data region length. */
export function writeSafetensors(
  path,
  header,
  { dataBytes = 0, pad = 0, sparse = false, declaredLength } = {},
) {
  const json = Buffer.from(header + " ".repeat(pad), "utf8");
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(declaredLength ?? json.length));
  const fd = openSync(path, "w");
  try {
    writeSync(fd, prefix);
    writeSync(fd, json);
    if (sparse) ftruncateSync(fd, 8 + json.length + dataBytes);
    else if (dataBytes) writeSync(fd, Buffer.alloc(dataBytes));
  } finally {
    closeSync(fd);
  }
  return 8 + json.length;
}

const T = {
  u8: 0,
  i8: 1,
  u16: 2,
  i16: 3,
  u32: 4,
  i32: 5,
  f32: 6,
  bool: 7,
  string: 8,
  array: 9,
  u64: 10,
  i64: 11,
  f64: 12,
};

function str(s) {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([len, b]);
}
function scalar(type, v) {
  const b = Buffer.alloc(
    {
      u8: 1,
      i8: 1,
      bool: 1,
      u16: 2,
      i16: 2,
      u32: 4,
      i32: 4,
      f32: 4,
      u64: 8,
      i64: 8,
      f64: 8,
    }[type],
  );
  ({
    u8: () => b.writeUInt8(v),
    i8: () => b.writeInt8(v),
    bool: () => b.writeUInt8(v),
    u16: () => b.writeUInt16LE(v),
    i16: () => b.writeInt16LE(v),
    u32: () => b.writeUInt32LE(v),
    i32: () => b.writeInt32LE(v),
    f32: () => b.writeFloatLE(v),
    u64: () => b.writeBigUInt64LE(BigInt(v)),
    i64: () => b.writeBigInt64LE(BigInt(v)),
    f64: () => b.writeDoubleLE(v),
  })[type]();
  return b;
}
function value(type, v) {
  if (type === "string") return str(v);
  if (type === "array") {
    const [elementType, items] = v;
    const head = Buffer.alloc(12);
    head.writeUInt32LE(T[elementType.split(":")[0]]);
    head.writeBigUInt64LE(BigInt(items.length), 4);
    const inner = elementType.includes(":")
      ? elementType.slice(elementType.indexOf(":") + 1)
      : undefined;
    return Buffer.concat([
      head,
      ...items.map((item) =>
        inner ? value("array", [inner, item]) : value(elementType, item),
      ),
    ]);
  }
  return scalar(type, v);
}

/**
 * Write a GGUF file. `kv` is [[key, type, value]]; arrays are
 * [key, "array", [elementType, items]] with "array:u8" for nested arrays.
 * `tensors` is [{name, dims, type, offset, bytes}]; offsets default to packed
 * aligned placement. `sparse` extends the file with a hole instead of zeros.
 */
export function writeGguf(
  path,
  {
    kv = [],
    tensors = [],
    version = 3,
    magic = "GGUF",
    alignment = 32,
    dataBytes,
    sparse = false,
    bigEndian = false,
    truncate,
  } = {},
) {
  const head = Buffer.alloc(24);
  head.write(magic, 0, "latin1");
  if (bigEndian) head.writeUInt32BE(version, 4);
  else head.writeUInt32LE(version, 4);
  head.writeBigUInt64LE(BigInt(tensors.length), 8);
  head.writeBigUInt64LE(BigInt(kv.length), 16);
  const parts = [head];
  for (const [key, type, v] of kv) {
    const t = Buffer.alloc(4);
    t.writeUInt32LE(typeof type === "number" ? type : T[type]);
    parts.push(str(key), t, value(typeof type === "number" ? "u8" : type, v));
  }
  let cursor = 0;
  const placed = [];
  for (const tensor of tensors) {
    const offset = tensor.offset ?? cursor;
    placed.push(offset + (tensor.bytes ?? 0));
    cursor = Math.ceil((offset + (tensor.bytes ?? 0)) / alignment) * alignment;
    const n = Buffer.alloc(4);
    n.writeUInt32LE(tensor.dims.length);
    const dims = tensor.dims.map((d) => scalar("u64", d));
    const tail = Buffer.alloc(12);
    tail.writeUInt32LE(tensor.type, 0);
    tail.writeBigUInt64LE(BigInt(offset), 4);
    parts.push(str(tensor.name), n, ...dims, tail);
  }
  const meta = Buffer.concat(parts);
  const dataStart = Math.ceil(meta.length / alignment) * alignment;
  const data = dataBytes ?? cursor;
  const fd = openSync(path, "w");
  try {
    writeSync(fd, meta);
    if (truncate !== undefined) ftruncateSync(fd, truncate);
    else if (sparse) ftruncateSync(fd, dataStart + data);
    else writeSync(fd, Buffer.alloc(dataStart - meta.length + data));
  } finally {
    closeSync(fd);
  }
  return { dataStart, descriptorEnd: meta.length };
}

// Protobuf wire encoding for ONNX fixtures the reference writer cannot make.
const varint = (value) => {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);
export const pb = {
  varint,
  int: (field, value) => Buffer.concat([tag(field, 0), varint(value)]),
  bytes: (field, payload) =>
    Buffer.concat([tag(field, 2), varint(payload.length), payload]),
  str: (field, text) => pb.bytes(field, Buffer.from(text, "utf8")),
  msg: (field, ...parts) => pb.bytes(field, Buffer.concat(parts)),
  raw: (...parts) => Buffer.concat(parts),
};

const attribute = (a) => {
  const parts = [pb.str(1, a.name)];
  if (a.type === "ints")
    parts.push(pb.int(20, 7), ...a.value.map((v) => pb.int(8, v)));
  else if (a.type === "int") parts.push(pb.int(20, 2), pb.int(3, a.value));
  else if (a.type === "graph")
    parts.push(pb.int(20, 5), pb.msg(6, onnxGraph(a.value)));
  return pb.msg(5, ...parts);
};
const onnxNode = (n) =>
  pb.msg(
    1,
    ...(n.inputs ?? []).map((i) => pb.str(1, i)),
    ...(n.outputs ?? []).map((o) => pb.str(2, o)),
    ...(n.name ? [pb.str(3, n.name)] : []),
    pb.str(4, n.op),
    ...(n.domain ? [pb.str(7, n.domain)] : []),
    ...(n.attributes ?? []).map(attribute),
  );
const valueInfo = (field, v) =>
  pb.msg(
    field,
    pb.str(1, v.name),
    pb.msg(
      2,
      pb.msg(
        1,
        pb.int(1, v.type ?? 1),
        pb.msg(
          2,
          ...(v.shape ?? []).map((d) =>
            pb.msg(1, typeof d === "string" ? pb.str(2, d) : pb.int(1, d)),
          ),
        ),
      ),
    ),
  );
const initializer = (t) =>
  pb.msg(
    5,
    ...t.dims.map((d) => pb.int(1, d)),
    pb.int(2, t.dataType ?? 1),
    pb.str(8, t.name),
    pb.bytes(9, t.raw ?? Buffer.alloc(t.rawLength ?? 0)),
  );

/** Encode a GraphProto from {name, nodes, initializers, inputs, outputs}. */
export function onnxGraph(g) {
  return Buffer.concat([
    ...(g.nodes ?? []).map(onnxNode),
    pb.str(2, g.name ?? "graph"),
    ...(g.initializers ?? []).map(initializer),
    ...(g.inputs ?? []).map((v) => valueInfo(11, v)),
    ...(g.outputs ?? []).map((v) => valueInfo(12, v)),
  ]);
}

/** Encode a ModelProto around one graph. */
export function onnxModel(
  graph,
  { irVersion = 9, opset = 17, extra = [] } = {},
) {
  return Buffer.concat([
    pb.int(1, irVersion),
    pb.str(2, "writers.mjs"),
    pb.msg(7, onnxGraph(graph)),
    pb.msg(8, pb.str(1, ""), pb.int(2, opset)),
    ...extra,
  ]);
}
