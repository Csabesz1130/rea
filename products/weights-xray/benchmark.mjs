// Inventory valid sparse checkpoints and record what each inspection cost.
// node products/weights-xray/benchmark.mjs [--runs 5] [--sizes 1,100] [--descriptors 1000,50000]
// Each run is a fresh Node process. "first" is the first run per file after it
// was written; later runs read headers from a warm page cache. The operating
// system cache is not dropped, so no run is cold with respect to the disk.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { onnxModel, writeGguf, writeSafetensors } from "./test/writers.mjs";

const { values } = parseArgs({
  options: {
    runs: { type: "string" },
    sizes: { type: "string" },
    descriptors: { type: "string" },
    "onnx-ops": { type: "string" },
    child: { type: "string" },
    strict: { type: "boolean" },
  },
});
if (values.child) {
  const { inspectFile } = await import("./src/inspect.mjs");
  const start = process.hrtime.bigint();
  const report = await inspectFile(values.child, { strict: !!values.strict });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  process.stdout.write(
    JSON.stringify({
      ms,
      complete: report.complete,
      valid: report.valid,
      tensors: report.tensor_count,
      nodes: report.node_count,
      size: report.file.size,
      requests: report.reads.requests,
      bytes_read: report.reads.bytes_read,
      payload_bytes_read: report.reads.payload_bytes_read,
      max_rss_kib: process.resourceUsage().maxRSS,
    }),
  );
  process.exit(0);
}

const runs = Number(values.runs ?? 5);
const sizes = (values.sizes ?? "1,100").split(",").map(Number);
const counts = (values.descriptors ?? "1000,50000").split(",").map(Number);
const dir = mkdtempSync(join(tmpdir(), "weights-xray-bench-"));
const self = fileURLToPath(import.meta.url);
const results = [];
function measure(path, strict = false) {
  const samples = [];
  for (let r = 0; r < runs; r++) {
    const args = [self, "--child", path, ...(strict ? ["--strict"] : [])];
    const child = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (child.status !== 0) throw new Error(child.stderr);
    samples.push(JSON.parse(child.stdout));
  }
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const last = samples.at(-1);
  results.push({
    file: path.slice(dir.length + 1) + (strict ? " (strict)" : ""),
    declared_bytes: last.size,
    tensors: last.tensors,
    ...(last.nodes !== undefined ? { nodes: last.nodes } : {}),
    complete: last.complete,
    valid: last.valid,
    first_ms: +samples[0].ms.toFixed(1),
    median_ms: +ms[Math.floor(ms.length / 2)].toFixed(1),
    max_ms: +ms.at(-1).toFixed(1),
    requests: last.requests,
    bytes_read: last.bytes_read,
    payload_bytes_read: Math.max(...samples.map((s) => s.payload_bytes_read)),
    peak_rss_mib: +(
      Math.max(...samples.map((s) => s.max_rss_kib)) / 1024
    ).toFixed(1),
  });
}
try {
  for (const gib of sizes)
    for (const n of counts) {
      const each = Math.floor((gib * 2 ** 30) / n / 32) * 32;
      const st = join(dir, `${gib}g-${n}.safetensors`);
      const header = {};
      for (let i = 0; i < n; i++)
        header[`model.layers.${i}.mlp.up_proj.weight`] = {
          dtype: "U8",
          shape: [each],
          data_offsets: [i * each, (i + 1) * each],
        };
      writeSafetensors(st, JSON.stringify(header), {
        dataBytes: each * n,
        sparse: true,
      });
      const gg = join(dir, `${gib}g-${n}.gguf`);
      writeGguf(gg, {
        kv: [["general.architecture", "string", "llama"]],
        tensors: Array.from({ length: n }, (_, i) => ({
          name: `blk.${i}.ffn_up.weight`,
          dims: [each],
          type: 24,
          bytes: each,
        })),
        sparse: true,
      });
      for (const path of [st, gg]) measure(path);
      rmSync(st);
      rmSync(gg);
    }
  // An operator DAG with a labeled join, 64 KiB-aligned initializers between
  // operators and a symbolic batch dimension.
  const ops = Number(values["onnx-ops"] ?? 64000);
  if (ops) {
    const kinds = ["MatMul", "Add", "Relu", "Transpose", "Reshape", "Mul"];
    const nodes = [];
    const initializers = [];
    for (let i = 0; i < ops; i++) {
      const prev = i ? `t${i - 1}` : "x";
      const inputs = [prev];
      if (i % 1000 === 0) {
        initializers.push({
          name: `w${i}`,
          dims: [256, 256],
          rawLength: 256 * 256 * 4,
        });
        inputs.push(`w${i}`);
      } else if (i % 16 === 0 && i > 8) inputs.push(`t${i - 8}`);
      const name =
        i === ops >> 1 ? "bottleneck/Transpose" : `layer${i >> 6}/op${i}`;
      nodes.push({
        op: i === ops >> 1 ? "Transpose" : kinds[i % kinds.length],
        name,
        inputs,
        outputs: [`t${i}`],
      });
    }
    const path = join(dir, `dag-${ops}.onnx`);
    writeFileSync(
      path,
      onnxModel({
        nodes,
        initializers,
        inputs: [{ name: "x", shape: ["batch", 256] }],
        outputs: [{ name: `t${ops - 1}` }],
      }),
    );
    measure(path);
    measure(path, true);
    rmSync(path);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      host: {
        cpus: cpus().length,
        model: cpus()[0]?.model,
        mem_gib: +(totalmem() / 2 ** 30).toFixed(1),
        node: process.version,
      },
      runs,
      results,
    },
    null,
    1,
  ),
);
