// ONNX ModelProto read from protobuf wire fields within each enclosing
// message's bounds. Weight payload fields are skipped by seeking, external
// data files are never opened, and subgraph depth is capped.
// https://onnx.ai/onnx/repo-docs/IR.html · https://protobuf.dev/programming-guides/encoding/
import { createHash } from "node:crypto";
import { BudgetError, FormatError, u64 } from "./errors.mjs";
import { Cursor } from "./source.mjs";
import { metadataValue } from "./report.mjs";

// TensorProto.DataType, pinned to onnx 1.23.2: [name, bits per element].
export const ONNX_TYPES = Object.freeze({
  0: ["UNDEFINED", null],
  1: ["FLOAT", 32],
  2: ["UINT8", 8],
  3: ["INT8", 8],
  4: ["UINT16", 16],
  5: ["INT16", 16],
  6: ["INT32", 32],
  7: ["INT64", 64],
  8: ["STRING", null],
  9: ["BOOL", 8],
  10: ["FLOAT16", 16],
  11: ["DOUBLE", 64],
  12: ["UINT32", 32],
  13: ["UINT64", 64],
  14: ["COMPLEX64", 64],
  15: ["COMPLEX128", 128],
  16: ["BFLOAT16", 16],
  17: ["FLOAT8E4M3FN", 8],
  18: ["FLOAT8E4M3FNUZ", 8],
  19: ["FLOAT8E5M2", 8],
  20: ["FLOAT8E5M2FNUZ", 8],
  21: ["UINT4", 4],
  22: ["INT4", 4],
  23: ["FLOAT4E2M1", 4],
  24: ["FLOAT8E8M0", 8],
  25: ["UINT2", 2],
  26: ["INT2", 2],
  27: ["FLOAT6E2M3", 6],
  28: ["FLOAT6E3M2", 6],
});
const ATTRIBUTE_TYPES = {
  0: "UNDEFINED",
  1: "FLOAT",
  2: "INT",
  3: "STRING",
  4: "TENSOR",
  5: "GRAPH",
  6: "FLOATS",
  7: "INTS",
  8: "STRINGS",
  9: "TENSORS",
  10: "GRAPHS",
  11: "SPARSE_TENSOR",
  12: "SPARSE_TENSORS",
  13: "TYPE_PROTO",
  14: "TYPE_PROTOS",
};
export const STANDARD_DOMAINS = new Set([
  "",
  "ai.onnx",
  "ai.onnx.ml",
  "ai.onnx.training",
  "ai.onnx.preview.training",
]);
// TensorProto payload fields: float_data, int32_data, string_data, int64_data,
// raw_data, double_data, uint64_data.
const PAYLOAD = new Set([4, 5, 6, 7, 9, 10, 11]);
const PREVIEW = 16;
const PREFETCH = 64 * 1024;
// Read-ahead within the operator run. It bounds the payload bytes an ordinary
// buffered read can transfer where the operator run meets the initializers.
// Read profiles. Locally a read is a syscall, so tensor fields are read
// exactly. Remotely a read is an HTTP request, so each initializer header is
// read in one small window that may carry a few payload bytes, which are counted.
const PROFILES = {
  local: { nodes: 16 * 1024, tensors: 0, between: 0 },
  remote: {
    nodes: 64 * 1024,
    tensors: 1024,
    between: 1024,
    maxBetween: 64 * 1024,
  },
};
const utf8 = new TextDecoder("utf-8", { fatal: true });

export const ONNX_LIMITS = Object.freeze({
  nodes: 262144,
  subgraphDepth: 8,
  values: 1 << 20,
  strict: false,
});

/** Protobuf primitives over a Cursor, bounded by a stack of message ends. */
class Wire {
  constructor(cur, payload) {
    this.cur = cur;
    this.ends = [cur.end];
    this.payload = payload;
    cur.horizon = () => this.ends.at(-1);
  }
  get pos() {
    return this.cur.pos;
  }
  async varint() {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.cur.pos >= this.ends.at(-1))
        throw new FormatError(
          "MESSAGE_OVERRUN",
          "Varint crosses the end of its message",
          this.cur.pos,
        );
      const b = await this.cur.u8();
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
    }
    throw new FormatError(
      "VARINT_TOO_LONG",
      "Varint exceeds ten bytes",
      this.cur.pos,
    );
  }
  async small() {
    const v = await this.varint();
    if (v > BigInt(Number.MAX_SAFE_INTEGER))
      throw new FormatError(
        "LENGTH_INVALID",
        "Length exceeds 2^53",
        this.cur.pos,
      );
    return Number(v);
  }
  async length() {
    const at = this.cur.pos;
    const n = await this.small();
    if (this.cur.pos + n > this.ends.at(-1))
      throw new FormatError(
        "MESSAGE_OVERRUN",
        `Field of ${n} bytes passes the end of its message`,
        at,
      );
    return n;
  }
  async string() {
    const at = this.cur.pos;
    const bytes = await this.cur.bytes(await this.length());
    try {
      return utf8.decode(bytes);
    } catch {
      throw new FormatError(
        "INVALID_UTF8",
        "String field is not valid UTF-8",
        at,
      );
    }
  }
  /** Skip a payload field's value: seek, never read. */
  async payloadField(wire) {
    const start = this.cur.pos;
    if (wire === 2) {
      const n = await this.length();
      const from = this.cur.pos;
      this.cur.skip(n);
      this.payload.push([from, from + n]);
      return n;
    }
    await this.skipValue(wire);
    this.payload.push([start, this.cur.pos]);
    return this.cur.pos - start;
  }
  async skipValue(wire) {
    if (wire === 0) return void (await this.varint());
    if (wire === 1) return this.cur.skip(8);
    if (wire === 5) return this.cur.skip(4);
    if (wire === 2) return this.cur.skip(await this.length());
    throw new FormatError(
      "WIRE_TYPE_UNSUPPORTED",
      `Wire type ${wire} is not used by ONNX`,
      this.cur.pos,
    );
  }
  /** Run `visit(field, wire)` for each field until the message end. */
  async message(visit) {
    const end = this.ends.at(-1);
    while (this.cur.pos < end) {
      const tag = await this.varint();
      const field = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      if (field === 0)
        throw new FormatError("FIELD_INVALID", "Field number 0", this.cur.pos);
      if (!(await visit(field, wire))) await this.skipValue(wire);
    }
    if (this.cur.pos !== end)
      throw new FormatError(
        "MESSAGE_OVERRUN",
        "Field crosses the end of its message",
        this.cur.pos,
      );
  }
  /**
   * Parse a length-delimited submessage with its own end bound. `prefetch`
   * buffers the whole message in one read when it is at most PREFETCH bytes.
   */
  async sub(wire, visit, prefetch = false) {
    if (wire !== 2)
      throw new FormatError(
        "WIRE_TYPE_MISMATCH",
        "Expected a length-delimited message",
        this.cur.pos,
      );
    const n = await this.length();
    const start = this.cur.pos;
    if (prefetch && n <= PREFETCH) await this.cur.prefetch(n);
    this.ends.push(start + n);
    try {
      await this.message(visit);
    } finally {
      this.ends.pop();
    }
    return [start, start + n];
  }
  /** Repeated scalar that may be packed (wire 2) or one value per field. */
  async repeated(wire, each, decode, list, limit) {
    if (wire === 2) {
      const n = await this.length();
      const end = this.cur.pos + n;
      this.ends.push(end);
      try {
        while (this.cur.pos < end) {
          const v = await decode();
          if (list.length < limit) list.push(v);
          else list.omitted = (list.omitted ?? 0) + 1;
        }
      } finally {
        this.ends.pop();
      }
      return;
    }
    if (wire !== each)
      throw new FormatError(
        "WIRE_TYPE_MISMATCH",
        "Unexpected wire type for a repeated field",
        this.cur.pos,
      );
    const v = await decode();
    if (list.length < limit) list.push(v);
    else list.omitted = (list.omitted ?? 0) + 1;
  }
  async float() {
    return (await this.cur.bytes(4)).readFloatLE(0);
  }
}

const int64 = (v) => u64(BigInt.asIntN(64, v));
const digest = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const docFacts = (text) => ({
  bytes: Buffer.byteLength(text, "utf8"),
  sha256: digest(text),
});

export const looksLikeOnnx = () => false;

/** Read an ONNX model's operator graph and initializer descriptors. */
export async function readOnnx(source, ctx) {
  const { report, issues, limits } = ctx;
  report.format = "onnx";
  const onnxLimits = { ...ONNX_LIMITS, ...(limits.onnx ?? {}) };
  const payload = [];
  ctx.payloadRanges = payload;
  // Reads are exact unless a message is prefetched. Messages that cannot hold
  // tensors are always prefetched; operator nodes, which can (a Constant's
  // value), are prefetched unless strict metadata-only mode is selected.
  const cur = new Cursor(source, { window: 0, budget: limits.metadataBytes });
  const nodePrefetch = !onnxLimits.strict;
  const profile = onnxLimits.strict
    ? { nodes: 0, tensors: 0, between: 0 }
    : PROFILES[source.costModel === "request" ? "remote" : "local"];
  report.read_mode = onnxLimits.strict
    ? "strict-metadata"
    : source.costModel === "request"
      ? "buffered-remote"
      : "buffered-nodes";
  const w = new Wire(cur, payload);
  const model = { opset_import: [] };
  const graphs = [];
  const nodes = [];
  const tensors = [];
  const functions = [];
  Object.assign(report, { model, graphs, nodes, tensors, functions });

  const valueInfo = async (wire) => {
    const info = {};
    await w.sub(
      wire,
      async (f, wt) => {
        if (f === 1 && wt === 2) info.name = await w.string();
        else if (f === 2 && wt === 2) info.type = await typeProto(wt);
        else if (f === 3 && wt === 2)
          info.doc_string = docFacts(await w.string());
        else return false;
        return true;
      },
      true,
    );
    return info;
  };
  const typeProto = async (wire) => {
    const type = {};
    await w.sub(wire, async (f, wt) => {
      if ((f === 1 || f === 8) && wt === 2) {
        const tensor = { shape: null };
        await w.sub(wt, async (tf, twt) => {
          if (tf === 1 && twt === 0)
            tensor.elem_type = ONNX_TYPES[await w.small()]?.[0] ?? "UNKNOWN";
          else if (tf === 2 && twt === 2) {
            tensor.shape = [];
            await w.sub(twt, async (sf, swt) => {
              if (sf !== 1 || swt !== 2) return false;
              const dim = {};
              await w.sub(swt, async (df, dwt) => {
                if (df === 1 && dwt === 0) dim.value = int64(await w.varint());
                else if (df === 2 && dwt === 2) dim.param = await w.string();
                else return false;
                return true;
              });
              tensor.shape.push(
                dim.value ??
                  (dim.param !== undefined ? { param: dim.param } : null),
              );
              return true;
            });
          } else return false;
          return true;
        });
        type[f === 1 ? "tensor" : "sparse_tensor"] = tensor;
      } else if ((f === 4 || f === 9) && wt === 2) {
        const inner = {};
        await w.sub(wt, async (sf, swt) =>
          sf === 1 && swt === 2
            ? ((inner.elem_type = await typeProto(swt)), true)
            : false,
        );
        type[f === 4 ? "sequence" : "optional"] = inner.elem_type ?? null;
      } else if (f === 5 && wt === 2) {
        const map = {};
        await w.sub(wt, async (mf, mwt) => {
          if (mf === 1 && mwt === 0)
            map.key_type = ONNX_TYPES[await w.small()]?.[0] ?? "UNKNOWN";
          else if (mf === 2 && mwt === 2) map.value_type = await typeProto(mwt);
          else return false;
          return true;
        });
        type.map = map;
      } else if (f === 7) type.opaque = true;
      else if (f === 6 && wt === 2) type.denotation = await w.string();
      else return false;
      return true;
    });
    return type;
  };

  // TensorProto fields are read exactly; any read-ahead could enter raw_data.
  const tensorProto = async (wire, graph, role) => {
    const saved = cur.window;
    cur.window = Math.max(saved, profile.tensors);
    try {
      return await tensorFields(wire, graph, role);
    } finally {
      cur.window = saved;
    }
  };
  const tensorFields = async (wire, graph, role) => {
    const t = {
      name: "",
      graph,
      role,
      data_type: "UNDEFINED",
      shape: [],
      payload_bytes: 0,
    };
    const external = {};
    let location = 0;
    let declaredType;
    {
      t.descriptor = await w.sub(wire, async (f, wt) => {
        if (f === 1)
          await w.repeated(
            wt,
            0,
            async () => int64(await w.varint()),
            t.shape,
            onnxLimits.values,
          );
        else if (f === 2 && wt === 0) {
          declaredType = await w.small();
          t.data_type =
            ONNX_TYPES[declaredType]?.[0] ?? `UNKNOWN_${declaredType}`;
        } else if (f === 8 && wt === 2) t.name = await w.string();
        else if (f === 14 && wt === 0) location = await w.small();
        else if (f === 13 && wt === 2) {
          let key, value;
          await w.sub(
            wt,
            async (ef, ewt) => {
              if (ef === 1 && ewt === 2) key = await w.string();
              else if (ef === 2 && ewt === 2) value = await w.string();
              else return false;
              return true;
            },
            true,
          );
          if (key !== undefined) external[key] = value ?? "";
        } else if (f === 12 && wt === 2)
          t.doc_string = docFacts(await w.string());
        else if (PAYLOAD.has(f)) {
          const n = await w.payloadField(wt);
          t.payload_bytes += n;
          t.payload_fields = [
            ...new Set([
              ...(t.payload_fields ?? []),
              f === 9 ? "raw_data" : "typed",
            ]),
          ];
        } else return false;
        return true;
      });
    }
    const elements = t.shape.reduce((a, b) => a * BigInt(b), 1n);
    t.elements = u64(elements);
    if (location === 1 || Object.keys(external).length) {
      t.storage = "external";
      t.external = {
        location: external.location ?? null,
        ...(external.offset !== undefined ? { offset: external.offset } : {}),
        ...(external.length !== undefined ? { length: external.length } : {}),
      };
      const loc = external.location;
      if (!loc)
        issues.error(
          "EXTERNAL_DATA_INVALID",
          `Tensor ${t.name} has external data without a location`,
          t.descriptor[0],
          t.name,
        );
      else if (
        /^([a-zA-Z]:|[/\\])/.test(loc) ||
        loc.split(/[/\\]/).includes("..")
      )
        issues.error(
          "EXTERNAL_DATA_OUTSIDE_ROOT",
          `Tensor ${t.name} names external data ${JSON.stringify(loc)} outside the model directory`,
          t.descriptor[0],
          t.name,
        );
    } else
      t.storage = t.payload_bytes
        ? t.payload_fields?.includes("raw_data")
          ? "raw"
          : "typed"
        : "empty";
    const bits = ONNX_TYPES[declaredType]?.[1];
    if (t.storage === "raw" && t.payload_fields.length === 1 && bits) {
      const expected = (elements * BigInt(bits) + 7n) / 8n;
      if (bits % 8) t.packing = "sub-byte";
      if (BigInt(t.payload_bytes) !== expected)
        issues.error(
          "SHAPE_BYTE_MISMATCH",
          `${t.name}: shape and ${t.data_type} require ${expected} bytes; raw_data holds ${t.payload_bytes}`,
          t.descriptor[0],
          t.name,
        );
    }
    if (declaredType === undefined || ONNX_TYPES[declaredType] === undefined)
      issues.warn(
        "UNKNOWN_DATA_TYPE",
        `Tensor ${t.name} has data type ${declaredType ?? "unset"}`,
        t.descriptor[0],
        t.name,
      );
    return t;
  };
  const sparseTensor = async (wire, graph, role) => {
    const sparse = { role, dims: [] };
    sparse.descriptor = await w.sub(wire, async (f, wt) => {
      if (f === 1 && wt === 2)
        sparse.values = await tensorProto(wt, graph, role + ".values");
      else if (f === 2 && wt === 2)
        sparse.indices = await tensorProto(wt, graph, role + ".indices");
      else if (f === 3)
        await w.repeated(
          wt,
          0,
          async () => int64(await w.varint()),
          sparse.dims,
          onnxLimits.values,
        );
      else return false;
      return true;
    });
    return sparse;
  };

  const attribute = async (wire, node, depth) => {
    const a = { name: "" };
    const ints = [];
    const floats = [];
    let strings = 0;
    const sub = [];
    const tensorsHere = [];
    let declared;
    await w.sub(wire, async (f, wt) => {
      if (f === 1 && wt === 2) a.name = await w.string();
      else if (f === 20 && wt === 0) declared = await w.small();
      else if (f === 21 && wt === 2) a.ref_attr_name = await w.string();
      else if (f === 13 && wt === 2) a.doc_string = docFacts(await w.string());
      else if (f === 2 && wt === 5) a.value = await w.float();
      else if (f === 3 && wt === 0) a.value = int64(await w.varint());
      else if (f === 4 && wt === 2) {
        const bytes = await cur.bytes(await w.length());
        try {
          a.value = metadataValue(utf8.decode(bytes));
        } catch {
          a.value = {
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }
      } else if ((f === 5 || f === 10) && wt === 2)
        tensorsHere.push(
          await tensorProto(
            wt,
            node.graph,
            `${node.id}.${a.name || "attribute"}`,
          ),
        );
      else if ((f === 22 || f === 23) && wt === 2)
        tensorsHere.push(
          await sparseTensor(
            wt,
            node.graph,
            `${node.id}.${a.name || "attribute"}`,
          ),
        );
      else if ((f === 6 || f === 11) && wt === 2)
        sub.push(
          await graphProto(
            wt,
            `${node.id}/${a.name || "attribute"}${f === 11 ? `[${sub.length}]` : ""}`,
            depth + 1,
            node.id,
          ),
        );
      else if (f === 7)
        await w.repeated(wt, 5, () => w.float(), floats, PREVIEW);
      else if (f === 8)
        await w.repeated(
          wt,
          0,
          async () => int64(await w.varint()),
          ints,
          PREVIEW,
        );
      else if (f === 9 && wt === 2) {
        strings++;
        await w.skipValue(wt);
      } else if ((f === 14 || f === 15) && wt === 2) {
        a.type_protos = (a.type_protos ?? 0) + 1;
        await w.skipValue(wt);
      } else return false;
      return true;
    });
    a.type =
      ATTRIBUTE_TYPES[declared] ??
      (declared === undefined
        ? inferType(a, ints, floats, strings, sub, tensorsHere)
        : `UNKNOWN_${declared}`);
    if (ints.length)
      a.value = ints.omitted
        ? { preview: ints, length: ints.length + ints.omitted }
        : ints;
    if (floats.length)
      a.value = floats.omitted
        ? { preview: floats, length: floats.length + floats.omitted }
        : floats;
    if (strings) a.strings = strings;
    if (sub.length) a.subgraphs = sub;
    if (tensorsHere.length)
      a.tensors = tensorsHere.map((t) =>
        t.values
          ? {
              sparse: true,
              values: brief(t.values),
              indices: t.indices && brief(t.indices),
            }
          : brief(t),
      );
    return a;
  };
  const brief = (t) => ({
    data_type: t.data_type,
    shape: t.shape,
    storage: t.storage,
    payload_bytes: t.payload_bytes,
    ...(t.external ? { external: t.external } : {}),
  });

  const nodeProto = async (wire, graph, ordinal, depth) => {
    if (nodes.length >= onnxLimits.nodes)
      throw new BudgetError(
        "NODE_BUDGET",
        `Graph has more than ${onnxLimits.nodes} operators`,
        cur.pos,
      );
    const node = {
      id: `${graph}/n${ordinal}`,
      graph,
      name: "",
      op_type: "",
      domain: "",
      inputs: [],
      outputs: [],
      attributes: [],
    };
    nodes.push(node);
    node.descriptor = await w.sub(
      wire,
      async (f, wt) => {
        if (f === 1 && wt === 2) node.inputs.push(await w.string());
        else if (f === 2 && wt === 2) node.outputs.push(await w.string());
        else if (f === 3 && wt === 2) node.name = await w.string();
        else if (f === 4 && wt === 2) node.op_type = await w.string();
        else if (f === 7 && wt === 2) node.domain = await w.string();
        else if (f === 8 && wt === 2) node.overload = await w.string();
        else if (f === 5 && wt === 2)
          node.attributes.push(await attribute(wt, node, depth));
        else if (f === 6 && wt === 2)
          node.doc_string = docFacts(await w.string());
        else return false;
        return true;
      },
      nodePrefetch,
    );
    ctx.lastVerified = { node: node.id, end: cur.pos };
    return node;
  };

  async function graphProto(wire, id, depth, parentNode) {
    if (depth > onnxLimits.subgraphDepth)
      throw new BudgetError(
        "SUBGRAPH_DEPTH_BUDGET",
        `Subgraphs nest deeper than ${onnxLimits.subgraphDepth}`,
        cur.pos,
      );
    const graph = {
      id,
      depth,
      ...(parentNode ? { parent_node: parentNode } : {}),
      name: "",
      inputs: [],
      outputs: [],
      value_info: 0,
      node_count: 0,
      initializers: 0,
    };
    graphs.push(graph);
    let ordinal = 0;
    let between = profile.between;
    const saved = cur.window;
    graph.descriptor = await w.sub(wire, async (f, wt) => {
      // Serializers emit fields in number order: the operator list, then
      // initializers. Buffer ahead within the operator run; read exactly once
      // an initializer appears, so read-ahead cannot enter the next payload.
      cur.window = nodePrefetch && f === 1 ? profile.nodes : between;
      if (f === 1 && wt === 2) {
        await nodeProto(wt, id, ordinal++, depth);
        graph.node_count++;
      } else if (f === 2 && wt === 2) graph.name = await w.string();
      else if (f === 5 && wt === 2) {
        if (tensors.length >= limits.tensors)
          throw new BudgetError(
            "TENSOR_BUDGET",
            `More than ${limits.tensors} initializers`,
            cur.pos,
          );
        tensors.push(await tensorProto(wt, id, "initializer"));
        // Grow the read-ahead while initializers carry little inline payload
        // (external or small tensors); a large payload resets it.
        between =
          tensors.at(-1).payload_bytes >= between
            ? profile.between
            : Math.min(between * 2, profile.maxBetween ?? profile.between);
        graph.initializers++;
        ctx.lastVerified = { tensor: tensors.at(-1).name, end: cur.pos };
      } else if (f === 15 && wt === 2) {
        const sparse = await sparseTensor(wt, id, "sparse_initializer");
        if (sparse.values)
          tensors.push({
            ...sparse.values,
            role: "sparse_initializer",
            sparse_dims: sparse.dims,
            indices: sparse.indices && brief(sparse.indices),
          });
        graph.initializers++;
      } else if (f === 11 && wt === 2) graph.inputs.push(await valueInfo(wt));
      else if (f === 12 && wt === 2) graph.outputs.push(await valueInfo(wt));
      else if (f === 13 && wt === 2) {
        graph.value_info++;
        await w.skipValue(wt);
      } else if (f === 10 && wt === 2)
        graph.doc_string = docFacts(await w.string());
      else return false;
      return true;
    });
    cur.window = saved;
    return id;
  }

  const metadataProps = Object.create(null);
  let graphCount = 0;
  await w.message(async (f, wt) => {
    if (f === 1 && wt === 0) model.ir_version = int64(await w.varint());
    else if (f === 2 && wt === 2) model.producer_name = await w.string();
    else if (f === 3 && wt === 2) model.producer_version = await w.string();
    else if (f === 4 && wt === 2) model.domain = await w.string();
    else if (f === 5 && wt === 0) model.model_version = int64(await w.varint());
    else if (f === 6 && wt === 2) model.doc_string = docFacts(await w.string());
    else if (f === 8 && wt === 2) {
      const opset = { domain: "" };
      await w.sub(
        wt,
        async (of, owt) => {
          if (of === 1 && owt === 2) opset.domain = await w.string();
          else if (of === 2 && owt === 0)
            opset.version = int64(await w.varint());
          else return false;
          return true;
        },
        true,
      );
      model.opset_import.push(opset);
    } else if (f === 7 && wt === 2) {
      if (graphCount++)
        throw new FormatError(
          "DUPLICATE_GRAPH",
          "ModelProto declares more than one graph",
          cur.pos,
        );
      await graphProto(wt, "g0", 0);
    } else if (f === 14 && wt === 2) {
      let key, value;
      await w.sub(
        wt,
        async (ef, ewt) => {
          if (ef === 1 && ewt === 2) key = await w.string();
          else if (ef === 2 && ewt === 2) value = await w.string();
          else return false;
          return true;
        },
        true,
      );
      if (key !== undefined) metadataProps[key] = metadataValue(value ?? "");
    } else if (f === 25 && wt === 2) {
      const fn = { domain: "", name: "", nodes: 0, inputs: [], outputs: [] };
      await w.sub(
        wt,
        async (ff, fwt) => {
          if (ff === 1 && fwt === 2) fn.name = await w.string();
          else if (ff === 10 && fwt === 2) fn.domain = await w.string();
          else if (ff === 4 && fwt === 2) fn.inputs.push(await w.string());
          else if (ff === 5 && fwt === 2) fn.outputs.push(await w.string());
          else if (ff === 7 && fwt === 2) {
            fn.nodes++;
            await w.skipValue(fwt);
          } else return false;
          return true;
        },
        nodePrefetch,
      );
      functions.push(fn);
    } else if (f === 20 && wt === 2) {
      model.training_info = (model.training_info ?? 0) + 1;
      await w.skipValue(wt);
    } else return false;
    return true;
  });
  if (Object.keys(metadataProps).length) model.metadata_props = metadataProps;
  if (model.ir_version === undefined)
    issues.error("IR_VERSION_MISSING", "ModelProto has no ir_version", 0);
  if (!graphCount) issues.error("GRAPH_MISSING", "ModelProto has no graph", 0);

  summarize(report, issues);
  report.tensor_count = tensors.length;
  report.node_count = nodes.length;
  report.coverage = {
    descriptor_bytes_parsed: cur.parsed,
    payload_bytes_skipped: payload.reduce((a, [s, e]) => a + e - s, 0),
  };
  report.complete = true;
}

function inferType(a, ints, floats, strings, sub, tensors) {
  if (sub.length) return sub.length > 1 ? "GRAPHS" : "GRAPH";
  if (tensors.length) return tensors.length > 1 ? "TENSORS" : "TENSOR";
  if (ints.length) return "INTS";
  if (floats.length) return "FLOATS";
  if (strings) return "STRINGS";
  if (typeof a.value === "number") return "FLOAT";
  if (typeof a.value === "string" && /^-?\d+$/.test(a.value)) return "INT";
  return a.value === undefined ? "UNDEFINED" : "STRING";
}

function summarize(report, issues) {
  const byType = Object.create(null);
  const custom = new Map();
  const local = new Set(report.functions.map((f) => `${f.domain}::${f.name}`));
  for (const n of report.nodes) {
    const key = n.domain ? `${n.domain}::${n.op_type}` : n.op_type;
    byType[key] = (byType[key] ?? 0) + 1;
    if (
      !STANDARD_DOMAINS.has(n.domain) ||
      local.has(`${n.domain}::${n.op_type}`)
    ) {
      const c = custom.get(key) ?? {
        domain: n.domain,
        op_type: n.op_type,
        count: 0,
        local_function: local.has(`${n.domain}::${n.op_type}`),
      };
      c.count++;
      custom.set(key, c);
    }
  }
  const external = new Map();
  for (const t of report.tensors)
    if (t.external?.location)
      external.set(
        t.external.location,
        (external.get(t.external.location) ?? 0) + 1,
      );
  const byDataType = Object.create(null);
  for (const t of report.tensors) {
    const e = (byDataType[t.data_type] ??= { tensors: 0, inline_bytes: 0 });
    e.tensors++;
    if (t.storage !== "external") e.inline_bytes += t.payload_bytes;
  }
  const connectivity = resolveOnnxGraph(report);
  for (const u of connectivity.unresolved.slice(0, 32))
    issues.warn(
      "UNRESOLVED_INPUT",
      `${u.node} reads ${JSON.stringify(u.input)}, which no node, input or initializer in scope provides`,
      undefined,
    );
  for (const d of connectivity.duplicate_outputs.slice(0, 32))
    issues.error(
      "DUPLICATE_OUTPUT",
      `${JSON.stringify(d.name)} is produced more than once in ${d.graph}`,
      undefined,
    );
  report.operators = {
    by_type: byType,
    custom_operators: [...custom.values()],
  };
  report.initializers = { by_data_type: byDataType };
  report.external_data = {
    references: [...external.values()].reduce((a, b) => a + b, 0),
    files: [...external.keys()].sort(),
    opened: 0,
  };
  report.connectivity = {
    edges: connectivity.edges.length,
    outer_scope_edges: connectivity.edges.filter((e) => e.scope === "outer")
      .length,
    unresolved_inputs: connectivity.unresolved.length,
  };
}

/**
 * Resolve every operator input to the value that provides it, innermost scope
 * first: a node output, a graph input or an initializer. Subgraphs may read
 * names from enclosing graphs. Unresolved names stay unresolved.
 */
export function resolveOnnxGraph(report) {
  const byGraph = new Map(report.graphs.map((g) => [g.id, g]));
  const scopes = new Map();
  const duplicates = [];
  const scope = (id) => {
    if (!scopes.has(id)) scopes.set(id, new Map());
    return scopes.get(id);
  };
  for (const g of report.graphs)
    for (const i of g.inputs)
      if (i.name)
        scope(g.id).set(i.name, {
          kind: "graph-input",
          id: `${g.id}:input:${i.name}`,
        });
  for (const t of report.tensors)
    if (t.role === "initializer" || t.role === "sparse_initializer")
      scope(t.graph).set(t.name, {
        kind: "initializer",
        id: `${t.graph}:initializer:${t.name}`,
      });
  for (const n of report.nodes)
    for (const o of n.outputs) {
      if (!o) continue;
      const s = scope(n.graph);
      if (s.get(o)?.kind === "node")
        duplicates.push({ graph: n.graph, name: o });
      s.set(o, { kind: "node", id: n.id });
    }
  const nodeGraph = new Map(report.nodes.map((n) => [n.id, n.graph]));
  const edges = [];
  const unresolved = [];
  for (const n of report.nodes)
    n.inputs.forEach((name, index) => {
      if (!name) return; // an omitted optional input
      let g = n.graph;
      let hops = 0;
      while (g) {
        const found = scopes.get(g)?.get(name);
        if (found) {
          edges.push({
            source: found.id,
            source_kind: found.kind,
            target: n.id,
            tensor: name,
            input_index: index,
            scope: hops ? "outer" : "local",
          });
          return;
        }
        const parent = byGraph.get(g)?.parent_node;
        g = parent ? nodeGraph.get(parent) : undefined;
        hops++;
      }
      unresolved.push({ node: n.id, input: name, input_index: index });
    });
  return { edges, unresolved, duplicate_outputs: duplicates };
}
