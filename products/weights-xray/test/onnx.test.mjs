import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LIMITS } from "../src/errors.mjs";
import { inspectFile } from "../src/inspect.mjs";
import { resolveOnnxGraph } from "../src/onnx.mjs";
import { onnxModel, pb } from "./writers.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const rea = fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url));
const reference = JSON.parse(
  readFileSync(join(fixtures, "reference-onnx.json"), "utf8"),
)["tiny-vision.onnx"];
const tmp = mkdtempSync(join(tmpdir(), "weights-xray-onnx-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const codes = (r) => r.issues.map((i) => i.code);
const write = (name, bytes) => {
  const path = join(tmp, name);
  writeFileSync(path, bytes);
  return path;
};

test("ONNX operators, subgraphs and initializers match the onnx reference reader", async () => {
  const report = await inspectFile(join(fixtures, "tiny-vision.onnx"));
  assert.ok(report.complete && report.valid, JSON.stringify(report.issues));
  assert.equal(report.model.ir_version, reference.ir_version);
  assert.equal(report.model.producer_name, reference.producer_name);
  assert.deepEqual(report.model.opset_import, reference.opset_import);
  assert.deepEqual(
    { ...report.model.metadata_props },
    reference.metadata_props,
  );
  assert.deepEqual(
    report.functions.map(({ domain, name, nodes }) => ({
      domain,
      name,
      nodes,
    })),
    reference.functions,
  );

  assert.deepEqual(
    report.nodes.map((n) => n.id).sort(),
    Object.keys(reference.nodes).sort(),
  );
  for (const n of report.nodes) {
    const ref = reference.nodes[n.id];
    assert.deepEqual(
      [n.name, n.op_type, n.domain, n.inputs, n.outputs],
      [ref.name, ref.op_type, ref.domain, ref.inputs, ref.outputs],
      n.id,
    );
    assert.deepEqual(
      Object.fromEntries(n.attributes.map((a) => [a.name, a.type])),
      ref.attributes,
      n.id,
    );
  }
  for (const t of report.tensors) {
    const ref = reference.initializers[t.name];
    assert.deepEqual(
      [t.graph, t.data_type, t.shape],
      [ref.graph, ref.data_type, ref.dims],
      t.name,
    );
    assert.equal(
      t.storage === "external",
      ref.data_location === "EXTERNAL",
      t.name,
    );
    if (t.storage === "external")
      assert.deepEqual({ ...t.external }, ref.external_data);
    else assert.equal(t.payload_bytes, ref.raw_bytes);
  }
  for (const [id, g] of Object.entries(reference.graphs)) {
    const ours = report.graphs.find((x) => x.id === id);
    for (const [name, v] of Object.entries(g.inputs)) {
      const i = ours.inputs.find((x) => x.name === name);
      assert.deepEqual(
        [i.type.tensor.elem_type, i.type.tensor.shape],
        [v.elem_type, v.shape],
        `${id} input ${name}`,
      );
    }
    for (const [name, v] of Object.entries(g.outputs)) {
      const o = ours.outputs.find((x) => x.name === name);
      assert.deepEqual(
        [o.type.tensor.elem_type, o.type.tensor.shape],
        [v.elem_type, v.shape],
        `${id} output ${name}`,
      );
    }
  }
  assert.deepEqual(report.operators.custom_operators, [
    {
      domain: "com.example",
      op_type: "FastGelu",
      count: 1,
      local_function: true,
    },
  ]);
  assert.deepEqual(
    { ...report.external_data },
    { references: 1, files: ["weights.bin"], opened: 0 },
  );

  // Both branches read `projected` from the enclosing graph.
  const { edges, unresolved } = resolveOnnxGraph(report);
  assert.deepEqual(unresolved, []);
  const outer = edges
    .filter((e) => e.scope === "outer")
    .map((e) => [e.source, e.target, e.tensor]);
  assert.deepEqual(outer.sort(), [
    ["g0/n5", "g0/n6/else_branch/n0", "projected"],
    ["g0/n5", "g0/n6/then_branch/n0", "projected"],
  ]);
  const conv = edges
    .filter((e) => e.target === "g0/n0")
    .map((e) => [e.source_kind, e.tensor]);
  assert.deepEqual(conv, [
    ["graph-input", "pixels"],
    ["initializer", "conv.weight"],
    ["initializer", "conv.bias"],
  ]);

  // Buffered mode counts what its read-ahead transferred; it never exceeds one window.
  assert.equal(report.read_mode, "buffered-nodes");
  assert.equal(report.coverage.payload_bytes_skipped, 432 + 16 + 16);
  assert.ok(
    report.reads.payload_bytes_read <= report.coverage.payload_bytes_skipped,
  );
});

test("strict metadata mode reads no tensor payload at all", async () => {
  const report = await inspectFile(join(fixtures, "tiny-vision.onnx"), {
    strict: true,
  });
  assert.ok(report.complete && report.valid);
  assert.equal(report.read_mode, "strict-metadata");
  assert.equal(report.reads.payload_bytes_read, 0);
  assert.equal(report.node_count, 9);
  const conv = report.tensors.find((t) => t.name === "conv.weight");
  const [start, end] = [conv.descriptor[1] - 432, conv.descriptor[1]];
  assert.ok(
    !report.reads.ranges.some(([s, e]) => s < end && e > start),
    "conv.weight payload bytes were read",
  );
});

test(
  "external data is never opened, even when the named file exists",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(join(tmp, "fifo-"));
    copyFileSync(join(fixtures, "tiny-vision.onnx"), join(dir, "model.onnx"));
    // Opening a FIFO for reading blocks until a writer appears, so any open hangs the test.
    assert.equal(spawnSync("mkfifo", [join(dir, "weights.bin")]).status, 0);
    const report = await inspectFile(join(dir, "model.onnx"));
    assert.ok(report.complete && report.valid);
    assert.equal(report.external_data.opened, 0);

    const escape = await inspectFile(join(fixtures, "escape.onnx"));
    assert.equal(escape.valid, false);
    assert.deepEqual(codes(escape), ["EXTERNAL_DATA_OUTSIDE_ROOT"]);
    assert.equal(escape.issues[0].tensor, "proj.weight");
  },
);

test("malformed protobuf, unresolved inputs, duplicate outputs and budgets are reported", async () => {
  const relu = (i, o, extra = {}) => ({
    op: "Relu",
    inputs: [i],
    outputs: [o],
    ...extra,
  });
  const input = [{ name: "x", shape: ["batch", 4] }];

  const good = onnxModel({
    nodes: [relu("x", "y")],
    inputs: input,
    outputs: [{ name: "y" }],
  });
  const truncated = await inspectFile(
    write("truncated.onnx", good.subarray(0, good.length - 7)),
  );
  assert.equal(truncated.valid, false);
  assert.ok(
    ["MESSAGE_OVERRUN", "TRUNCATED"].includes(codes(truncated)[0]),
    JSON.stringify(truncated.issues),
  );

  const unresolved = await inspectFile(
    write(
      "unresolved.onnx",
      onnxModel({ nodes: [relu("missing", "y")], inputs: input }),
    ),
  );
  assert.ok(unresolved.valid);
  assert.deepEqual(codes(unresolved), ["UNRESOLVED_INPUT"]);
  assert.equal(unresolved.connectivity.unresolved_inputs, 1);

  const twice = await inspectFile(
    write(
      "twice.onnx",
      onnxModel({ nodes: [relu("x", "y"), relu("x", "y")], inputs: input }),
    ),
  );
  assert.deepEqual(codes(twice), ["DUPLICATE_OUTPUT"]);

  const mismatch = onnxModel({
    nodes: [],
    initializers: [{ name: "w", dims: [4], rawLength: 12 }],
  });
  assert.deepEqual(codes(await inspectFile(write("mismatch.onnx", mismatch))), [
    "SHAPE_BYTE_MISMATCH",
  ]);

  let graph = { name: "leaf", nodes: [relu("x", "y")] };
  for (let d = 0; d < 9; d++)
    graph = {
      name: `level${d}`,
      nodes: [
        {
          op: "If",
          inputs: ["x"],
          outputs: [`o${d}`],
          attributes: [{ name: "then_branch", type: "graph", value: graph }],
        },
      ],
    };
  const deep = await inspectFile(
    write("deep.onnx", onnxModel({ ...graph, inputs: input })),
  );
  assert.equal(deep.incomplete.reason, "SUBGRAPH_DEPTH_BUDGET");

  const many = onnxModel({
    nodes: Array.from({ length: 10 }, (_, i) =>
      relu(i ? `h${i - 1}` : "x", `h${i}`),
    ),
    inputs: input,
  });
  const capped = await inspectFile(write("many.onnx", many), {
    limits: { ...LIMITS, onnx: { nodes: 4 } },
  });
  assert.deepEqual(
    [
      capped.complete,
      capped.incomplete.reason,
      capped.incomplete.last_verified.node,
    ],
    [false, "NODE_BUDGET", "g0/n3"],
  );
  assert.equal(capped.nodes.length, 4);

  const group = Buffer.concat([pb.int(1, 9), Buffer.from([(3 << 3) | 3])]);
  assert.deepEqual(codes(await inspectFile(write("group.onnx", group))), [
    "WIRE_TYPE_UNSUPPORTED",
  ]);
  const budget = await inspectFile(write("budget.onnx", good), {
    limits: { ...LIMITS, metadataBytes: 8 },
  });
  assert.equal(budget.incomplete.reason, "METADATA_BUDGET");
});

test("rea weights inspect pages ONNX nodes and selects strict mode", () => {
  const run = spawnSync(
    process.execPath,
    [
      rea,
      "weights",
      "inspect",
      join(fixtures, "tiny-vision.onnx"),
      "--limit",
      "2",
      "--strict-metadata",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.nodes_page, {
    offset: 0,
    limit: 2,
    total: 9,
    more: true,
  });
  assert.deepEqual(
    out.nodes.map((n) => n.op_type),
    ["Conv", "Relu"],
  );
  assert.equal(out.reads.payload_bytes_read, 0);
  assert.equal(
    spawnSync(process.execPath, [
      rea,
      "weights",
      "inspect",
      join(fixtures, "escape.onnx"),
    ]).status,
    2,
  );
});
