import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
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
import { inspectFile, inspectSource } from "../src/inspect.mjs";
import { LocalSource } from "../src/source.mjs";
import { writeGguf, writeSafetensors } from "./writers.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const rea = fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url));
const reference = JSON.parse(
  readFileSync(join(fixtures, "reference.json"), "utf8"),
);
const tmp = mkdtempSync(join(tmpdir(), "weights-xray-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const file = (name) => join(tmp, name);
const codes = (report) => report.issues.map((i) => i.code);
const issue = (report, code) => report.issues.find((i) => i.code === code);

test("safetensors inventories match the reference reader, cite descriptors and read no weights", async () => {
  for (const name of ["pair-base.safetensors", "pair-tuned.safetensors"]) {
    const expected = reference[name];
    const report = await inspectFile(join(fixtures, name));
    assert.equal(report.format, "safetensors");
    assert.ok(report.complete && report.valid, JSON.stringify(report.issues));
    assert.equal(report.header.json_bytes, expected.header_bytes);
    assert.deepEqual({ ...report.metadata }, expected.metadata);
    assert.equal(report.tensor_count, Object.keys(expected.tensors).length);
    const bytes = readFileSync(join(fixtures, name));
    for (const t of report.tensors) {
      const ref = expected.tensors[t.name];
      assert.ok(ref, t.name);
      assert.equal(t.dtype, ref.dtype);
      assert.deepEqual(t.shape, ref.shape);
      assert.deepEqual(t.data_offsets, ref.data_offsets);
      // The cited descriptor span is exactly the JSON member for this tensor.
      const member = bytes
        .subarray(t.descriptor[0], t.descriptor[1])
        .toString("utf8");
      assert.ok(member.startsWith(JSON.stringify(t.name) + ":"), member);
      assert.deepEqual(
        JSON.parse("{" + member + "}")[t.name].data_offsets,
        ref.data_offsets,
      );
    }
    assert.equal(report.reads.payload_bytes_read, 0);
    assert.deepEqual(report.reads.ranges, [[0, 8 + expected.header_bytes]]);
  }
  const tuned = await inspectFile(join(fixtures, "pair-tuned.safetensors"));
  const scalar = tuned.tensors.find(
    (t) => t.name === "model.scalar_temperature",
  );
  assert.deepEqual([scalar.shape, scalar.elements, scalar.bytes], [[], 1, 4]);
  const empty = tuned.tensors.find((t) => t.name === "model.empty_cache");
  assert.deepEqual([empty.shape, empty.elements, empty.bytes], [[0, 8], 0, 0]);
});

test("GGUF descriptors match gguf-py, including quantized storage, typed metadata and the data offset", async () => {
  const expected = reference["tiny-llama.gguf"];
  const report = await inspectFile(join(fixtures, "tiny-llama.gguf"));
  assert.ok(report.complete && report.valid, JSON.stringify(report.issues));
  assert.equal(report.version, expected.version);
  assert.equal(report.alignment, expected.alignment);
  assert.equal(report.data.data_start, expected.data_offset);
  assert.equal(report.tensor_count, Object.keys(expected.tensors).length);
  for (const t of report.tensors) {
    const ref = expected.tensors[t.name];
    assert.equal(t.type, ref.type, t.name);
    assert.deepEqual(t.shape, ref.shape, t.name);
    assert.equal(t.elements, ref.elements, t.name);
    assert.equal(t.bytes, ref.bytes, t.name);
    assert.equal(t.file_range[0], ref.file_offset, t.name);
  }
  for (const [key, ref] of Object.entries(expected.metadata)) {
    const ours = report.metadata[key];
    if (ref?.array_of) {
      assert.equal(ours.element_type, ref.array_of, key);
      if (ref.array_of !== "ARRAY") assert.equal(ours.length, ref.length, key);
    } else if (
      typeof ref === "number" &&
      !Number.isSafeInteger(ref) &&
      Number.isInteger(ref)
    ) {
      assert.equal(ours, "9223372036854775813", key); // exact u64 beyond 2^53
    } else assert.equal(ours, ref, key);
  }
  assert.deepEqual(
    report.metadata["tiny.nested"].values.map((v) => v.values),
    [
      [1, 2],
      [3, 4, 5],
    ],
  );
  assert.equal(report.architecture.name, "llama");
  assert.equal(report.architecture.derived.query_heads_per_kv_head, 2);
  assert.equal(
    report.architecture.declared["general.file_type"],
    "MOSTLY_Q4_K_M",
  );
  assert.deepEqual(report.quantization.mixed_roles, [
    { role: "blk.*.attn_k.weight", types: { Q8_0: "0", Q4_0: "1" } },
  ]);
  assert.deepEqual(
    { ...report.chat_templates[0].statements },
    { for: 1, if: 1, endif: 1, endfor: 1 },
  );
  assert.equal(report.reads.payload_bytes_read, 0);
  assert.deepEqual(report.reads.ranges, [[0, report.data.descriptor_end]]);
});

test("sharded index admits sibling shards and names missing, mismapped and escaping entries", async () => {
  const index = join(fixtures, "sharded/model.safetensors.index.json");
  const ok = await inspectFile(index);
  assert.ok(ok.complete && ok.valid, JSON.stringify(ok.issues));
  assert.equal(ok.tensor_count, 8);
  assert.equal(ok.tensor_bytes, ok.declared_total_size);
  assert.equal(ok.reads.payload_bytes_read, 0);

  const dir = file("shards");
  mkdirSync(dir);
  const shards = [
    "model-00001-of-00002.safetensors",
    "model-00002-of-00002.safetensors",
  ];
  copyFileSync(join(fixtures, "sharded", shards[0]), join(dir, shards[0]));
  const original = JSON.parse(readFileSync(index, "utf8"));
  const variant = (name, weightMap) => {
    const path = join(dir, name + ".index.json");
    writeFileSync(path, JSON.stringify({ ...original, weight_map: weightMap }));
    return path;
  };
  const missing = await inspectFile(variant("missing", original.weight_map));
  assert.deepEqual(codes(missing), ["MISSING_SHARD"]);
  assert.equal(missing.complete, false);

  copyFileSync(join(fixtures, "sharded", shards[1]), join(dir, shards[1]));
  const moved = { ...original.weight_map, "lm_head.weight": shards[0] };
  const mismapped = await inspectFile(variant("mismapped", moved));
  assert.deepEqual(codes(mismapped), ["MISMAPPED_TENSOR"]);
  const ghost = await inspectFile(
    variant("ghost", { ...original.weight_map, "ghost.weight": shards[0] }),
  );
  assert.deepEqual(codes(ghost), ["MISSING_TENSOR"]);

  const escaping = await inspectFile(
    variant("escaping", {
      ...original.weight_map,
      extra: "../outside.safetensors",
    }),
  );
  assert.ok(codes(escaping).includes("SHARD_OUTSIDE_ROOT"));
  const unmapped = { ...original.weight_map };
  delete unmapped["lm_head.weight"];
  assert.ok(
    codes(await inspectFile(variant("unmapped", unmapped))).includes(
      "UNMAPPED_TENSOR",
    ),
  );
});

test("safetensors violations carry a stable code and the offset of the descriptor that caused them", async () => {
  const cases = {
    duplicate: [
      '{"a":{"dtype":"F32","shape":[1],"data_offsets":[0,4]},"a":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}',
      4,
      "DUPLICATE_KEY",
    ],
    overlap: [
      '{"a":{"dtype":"F32","shape":[2],"data_offsets":[0,8]},"b":{"dtype":"F32","shape":[1],"data_offsets":[4,8]}}',
      8,
      "OVERLAP",
    ],
    gap: ['{"a":{"dtype":"F32","shape":[1],"data_offsets":[4,8]}}', 8, "GAP"],
    trailing: [
      '{"a":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}',
      8,
      "TRAILING_DATA",
    ],
    mismatch: [
      '{"a":{"dtype":"F16","shape":[3],"data_offsets":[0,4]}}',
      4,
      "SHAPE_BYTE_MISMATCH",
    ],
    beyond: [
      '{"a":{"dtype":"U8","shape":[18446744073709551615],"data_offsets":[0,18446744073709551615]}}',
      0,
      "DATA_OUT_OF_BOUNDS",
    ],
    reversed: [
      '{"a":{"dtype":"U8","shape":[0],"data_offsets":[4,0]}}',
      4,
      "OFFSETS_INVALID",
    ],
    metadata: ['{"__metadata__":{"n":1}}', 0, "METADATA_NOT_STRING_MAP"],
    oddF4: [
      '{"a":{"dtype":"F4","shape":[3],"data_offsets":[0,2]}}',
      2,
      "MISALIGNED_SLICE",
    ],
    notObject: ['["a"]', 0, "HEADER_NOT_OBJECT"],
    syntax: ['{"a":', 0, "JSON_SYNTAX"],
  };
  for (const [name, [header, data, code]] of Object.entries(cases)) {
    writeSafetensors(file(name + ".safetensors"), header, { dataBytes: data });
    const report = await inspectFile(file(name + ".safetensors"));
    assert.equal(report.valid, false, name);
    const found = issue(report, code);
    assert.ok(found, `${name}: ${JSON.stringify(report.issues)}`);
    assert.ok(
      Number.isInteger(found.at) && found.at >= 8,
      `${name} cites ${found.at}`,
    );
  }
  const dup = await inspectFile(file("duplicate.safetensors"));
  assert.equal(
    issue(dup, "DUPLICATE_KEY").at,
    8 + header("duplicate").lastIndexOf('"a"'),
  );
  const beyond = await inspectFile(file("beyond.safetensors"));
  assert.equal(beyond.tensors[0].bytes, "18446744073709551615");
  function header(name) {
    return cases[name][0];
  }
});

test("safetensors edge cases: padding, empty headers, sub-byte and unknown dtypes, budgets, damaged magic", async () => {
  writeSafetensors(
    file("padded.safetensors"),
    '{"a":{"dtype":"BF16","shape":[2,1],"data_offsets":[0,4]}}',
    { dataBytes: 4, pad: 6 },
  );
  const padded = await inspectFile(file("padded.safetensors"));
  assert.ok(padded.valid && padded.complete, JSON.stringify(padded.issues));
  writeSafetensors(file("empty.safetensors"), "{}");
  const empty = await inspectFile(file("empty.safetensors"));
  assert.deepEqual(
    [empty.valid, empty.complete, empty.tensor_count],
    [true, true, 0],
  );
  writeSafetensors(
    file("f4.safetensors"),
    '{"a":{"dtype":"F4","shape":[4],"data_offsets":[0,2]},"b":{"dtype":"Q9","shape":[1],"data_offsets":[2,3]}}',
    { dataBytes: 3 },
  );
  const f4 = await inspectFile(file("f4.safetensors"));
  assert.ok(f4.valid, JSON.stringify(f4.issues));
  assert.deepEqual(codes(f4), ["SUB_BYTE_LAYOUT", "UNKNOWN_DTYPE"]);
  assert.equal(f4.tensors[1].storage, "unknown");

  writeSafetensors(
    file("budget.safetensors"),
    '{"a":{"dtype":"U8","shape":[1],"data_offsets":[0,1]}}',
    { dataBytes: 1 },
  );
  const small = await inspectFile(file("budget.safetensors"), {
    limits: { ...LIMITS, metadataBytes: 16 },
  });
  assert.deepEqual(
    [small.complete, small.valid, small.incomplete.reason],
    [false, true, "METADATA_BUDGET"],
  );
  assert.equal(small.reads.bytes_read, 9 + 8);

  writeSafetensors(file("long.safetensors"), "{}", { declaredLength: 1000 });
  assert.ok(
    codes(await inspectFile(file("long.safetensors"))).includes(
      "HEADER_LENGTH_EXCEEDS_FILE",
    ),
  );
  writeSafetensors(file("damaged.safetensors"), ' {"a":1}');
  assert.ok(
    codes(await inspectFile(file("damaged.safetensors"))).includes(
      "HEADER_NOT_OBJECT",
    ),
  );
});

test("GGUF violations, unsupported layouts and budgets are reported with offsets and partial coverage", async () => {
  const f32 = (name, n, extra = {}) => ({
    name,
    dims: [n],
    type: 0,
    bytes: n * 4,
    ...extra,
  });
  const write = (name, options) => (
    writeGguf(file(name + ".gguf"), options),
    inspectFile(file(name + ".gguf"))
  );

  assert.deepEqual(codes(await write("magic", { magic: "GGUX" })), [
    "BAD_MAGIC",
  ]);
  const v1 = await write("v1", { version: 1 });
  assert.deepEqual(
    [v1.valid, v1.complete, v1.incomplete.reason],
    [true, false, "UNSUPPORTED_VERSION"],
  );
  assert.equal(
    (await write("be", { bigEndian: true })).incomplete.reason,
    "BIG_ENDIAN_UNSUPPORTED",
  );

  const align = await write("align", {
    kv: [["general.alignment", "u32", 12]],
    tensors: [f32("a", 8)],
  });
  assert.ok(codes(align).includes("ALIGNMENT_INVALID"));
  assert.equal(align.alignment, 32);
  assert.ok(
    codes(
      await write("misaligned", {
        tensors: [f32("a", 8, { offset: 4 })],
        dataBytes: 64,
      }),
    ).includes("OFFSET_MISALIGNED"),
  );
  const rows = await write("rows", {
    tensors: [{ name: "q", dims: [48, 2], type: 2, bytes: 54 }],
  });
  assert.ok(codes(rows).includes("ROW_NOT_DIVISIBLE"));
  const unknown = await write("unknown", {
    tensors: [
      { name: "u", dims: [32], type: 200, bytes: 32 },
      { name: "q81", dims: [32], type: 9, bytes: 36 },
    ],
  });
  assert.ok(unknown.valid, JSON.stringify(unknown.issues));
  assert.deepEqual(
    unknown.tensors.map((t) => [t.type, t.storage]),
    [
      ["UNKNOWN_200", "unknown"],
      ["Q8_1", "unknown"],
    ],
  );
  const overlap = await write("overlap", {
    tensors: [f32("a", 16, { offset: 0 }), f32("b", 8, { offset: 32 })],
    dataBytes: 64,
  });
  assert.equal(issue(overlap, "OVERLAP").tensor, "b");
  const beyond = await write("beyond", {
    tensors: [f32("a", 16)],
    dataBytes: 32,
  });
  assert.ok(codes(beyond).includes("DATA_OUT_OF_BOUNDS"));
  const hidden = await write("hidden", {
    tensors: [f32("a", 8, { offset: 64 })],
    dataBytes: 128,
  });
  assert.ok(codes(hidden).includes("UNREFERENCED_DATA"));
  const dup = await write("dupkey", {
    kv: [
      ["k", "u8", 1],
      ["k", "u8", 2],
    ],
  });
  assert.equal(issue(dup, "DUPLICATE_KEY").at, 24 + 8 + 1 + 4 + 1);
  assert.ok(
    codes(
      await write("dupname", { tensors: [f32("a", 8), f32("a", 8)] }),
    ).includes("DUPLICATE_TENSOR"),
  );
  assert.ok(
    codes(await write("badtype", { kv: [["k", 99, 0]] })).includes(
      "UNKNOWN_VALUE_TYPE",
    ),
  );
  assert.ok(
    codes(
      await write("dims", {
        tensors: [{ name: "x", dims: [1, 1, 1, 1, 1], type: 0, bytes: 4 }],
      }),
    ).includes("TOO_MANY_DIMS"),
  );
  assert.ok(
    codes(
      await write("truncated", {
        kv: [["general.name", "string", "x".repeat(64)]],
        truncate: 40,
      }),
    ).includes("TRUNCATED"),
  );

  writeGguf(file("array.gguf"), {
    kv: [
      ["first", "u8", 7],
      ["tokens", "array", ["string", ["a", "b", "c", "d"]]],
    ],
  });
  const budget = await inspectFile(file("array.gguf"), {
    limits: { ...LIMITS, arrayElements: 3 },
  });
  assert.deepEqual(
    [
      budget.complete,
      budget.incomplete.reason,
      budget.incomplete.last_verified.metadata,
    ],
    [false, "ARRAY_BUDGET", "first"],
  );
  assert.equal(budget.metadata.first, 7);
  let nested = ["u8", [1]];
  for (let d = 0; d < 9; d++) nested = ["array:" + nested[0], [nested[1]]];
  writeGguf(file("deep.gguf"), { kv: [["deep", "array", nested]] });
  assert.equal(
    (await inspectFile(file("deep.gguf"))).incomplete.reason,
    "ARRAY_DEPTH_BUDGET",
  );
});

test("a file that changes during inspection is never reported as verified", async () => {
  const path = file("changing.safetensors");
  writeSafetensors(
    path,
    '{"a":{"dtype":"U8","shape":[4],"data_offsets":[0,4]}}',
    { dataBytes: 4 },
  );
  const source = await LocalSource.open(path);
  try {
    appendFileSync(path, Buffer.alloc(4));
    const report = await inspectSource(source);
    assert.equal(report.complete, false);
    assert.ok(codes(report).includes("FILE_CHANGED"));
  } finally {
    await source.close();
  }
});

test("sparse 1 GiB safetensors and GGUF files are inventoried without reading a weight byte", async () => {
  const GiB = 1 << 30;
  const tensors = 1000;
  const each = GiB / tensors - ((GiB / tensors) % 32);
  const header = {};
  for (let i = 0; i < tensors; i++)
    header[`model.layers.${i}.mlp.weight`] = {
      dtype: "U8",
      shape: [each],
      data_offsets: [i * each, (i + 1) * each],
    };
  writeSafetensors(file("big.safetensors"), JSON.stringify(header), {
    dataBytes: each * tensors,
    sparse: true,
  });
  writeGguf(file("big.gguf"), {
    kv: [
      ["general.architecture", "string", "llama"],
      [
        "tokenizer.ggml.tokens",
        "array",
        ["string", Array.from({ length: 5000 }, (_, i) => "t" + i)],
      ],
    ],
    tensors: Array.from({ length: tensors }, (_, i) => ({
      name: `blk.${i}.ffn_up.weight`,
      dims: [each],
      type: 24,
      bytes: each,
    })),
    sparse: true,
  });
  for (const name of ["big.safetensors", "big.gguf"]) {
    const report = await inspectFile(file(name));
    assert.ok(
      report.complete && report.valid,
      `${name}: ${JSON.stringify(report.issues)}`,
    );
    assert.equal(report.tensor_count, tensors);
    assert.ok(report.file.size >= tensors * each);
    assert.equal(report.reads.payload_bytes_read, 0, name);
  }
  assert.ok(process.memoryUsage().rss < 512 * 1024 * 1024);
});

test("rea weights inspect pages tensors, hashes on request and exits by outcome", () => {
  const run = (...args) =>
    spawnSync(process.execPath, [rea, "weights", ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
  const ok = run(
    "inspect",
    join(fixtures, "pair-base.safetensors"),
    "--limit",
    "2",
    "--offset",
    "1",
    "--sha256",
  );
  assert.equal(ok.status, 0, ok.stderr);
  const report = JSON.parse(ok.stdout);
  assert.deepEqual(report.tensors_page, {
    offset: 1,
    limit: 2,
    total: 8,
    more: true,
  });
  assert.equal(report.tensors.length, 2);
  const digest = createHash("sha256")
    .update(readFileSync(join(fixtures, "pair-base.safetensors")))
    .digest("hex");
  assert.equal(report.file.sha256, digest);
  assert.equal(report.reads.payload_bytes_read, 0);
  assert.equal(report.reads.hashing_pass_bytes, report.file.size);
  assert.doesNotMatch(ok.stdout, new RegExp(fixtures.replaceAll("/", "\\/")));

  assert.equal(run("inspect", file("overlap.safetensors")).status, 2);
  assert.equal(run("inspect", file("v1.gguf")).status, 3);
  assert.equal(run("inspect", file("does-not-exist.gguf")).status, 1);
  assert.equal(run("inspect").status, 1);
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /rea weights inspect FILE/);
});
