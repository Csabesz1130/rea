# Weights X-Ray

Read the tensor inventory of a local model file without loading its weights.
`rea weights inspect` reports every tensor's name, shape, storage type, byte
extent and the file bytes of the descriptor that declared it. It reads the
header and descriptor table only and counts every byte it reads.

```sh
rea weights inspect ./model.safetensors
rea weights inspect ./model.safetensors.index.json --limit 0
rea weights inspect ./model-Q4_K_M.gguf --offset 100 --limit 50
rea weights inspect ./encoder.onnx --strict-metadata
```

It runs nothing from the file, renders no template and loads no framework.

## Formats

| Input                          | Verified                                                                                                                                   | Reported                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.safetensors`                 | Eight-byte header length, strict UTF-8 JSON (duplicate keys rejected), dtype × shape = byte length, contiguous coverage of the data region | Tensors, `__metadata__`, dtype totals, parameter count, header SHA-256                                                                                |
| `model.safetensors.index.json` | Each shard is a regular sibling file; every `weight_map` entry against the shard that stores it; `metadata.total_size`                     | Per-shard results, missing, mismapped, unmapped and conflicting tensors                                                                               |
| `.gguf` v2/v3, little-endian   | Typed key/value metadata, tensor descriptors, alignment, block divisibility, aligned offsets, bounds and overlap                           | Metadata (long strings and arrays by preview and digest), architecture hyperparameters, storage types by tensor role, chat-template statement counts  |
| `.onnx`                        | Protobuf wire fields within each enclosing message, SSA outputs per graph, raw_data length against shape and type, external data locations | Operators with inputs, outputs and attributes, subgraphs, initializers, symbolic shapes, opsets, custom domains and local functions, input resolution |

Storage sizes come from pinned tables: the safetensors `Dtype` enum and gguf-py
0.19.0 `GGML_QUANT_SIZES`. A type outside the table gets `storage: "unknown"`
and a warning rather than a guessed extent. Q8_1 is reported that way on
purpose: it is a dot-product intermediate and the Python table (40 bytes per
block) disagrees with ggml's `block_q8_1` (36). Sub-byte safetensors dtypes
(`F4`, `F6_*`) are sized by bit count and marked `packing: "sub-byte"`.

GGUF axis order is preserved as declared (`ne0` first), as gguf-py reports it.
64-bit quantities are JSON numbers when exact and decimal strings otherwise.

### ONNX

The reader decodes tags and length prefixes within each message's bounds and
seeks past every tensor payload field (`raw_data` and the typed `*_data`
fields), so it never loads an initializer. External data is reported with its
location, offset and length and is never opened; a location that is absolute or
contains `..` is a `EXTERNAL_DATA_OUTSIDE_ROOT` error. Symbolic dimensions stay
symbolic (`{"param": "batch"}`). Node IDs are positional and stable for a given
file: `g0/n12`, and `g0/n12/then_branch/n0` inside a subgraph attribute.

`resolveOnnxGraph` connects each operator input to the node output, graph input
or initializer that provides it, innermost scope first, so a subgraph may read
names from enclosing graphs (`scope: "outer"`). An input nothing provides is an
`UNRESOLVED_INPUT` warning, and a name produced twice in one graph is a
`DUPLICATE_OUTPUT` error.

Protobuf does not fix field order, so read-ahead cannot be proven free of
payload. By default (`read_mode: "buffered-nodes"`) operator nodes are buffered
in 16 KiB windows while the parser is in the operator list, and TensorProto
fields are always read exactly. Payload bytes that a buffered read did transfer,
such as a small `Constant` value inside a node, are counted in
`payload_bytes_read`. `--strict-metadata` prefetches only messages that cannot
hold a tensor and reads operator nodes field by field: no payload byte is
transferred, at the cost of many more reads.

## What the output does and does not establish

`valid` means no format violation was found in the descriptors that were read.
`complete` means every descriptor was read and verified. Each issue has a
severity, a stable `code`, a message and the file offset `at` that caused it.

A descriptor inventory establishes declared layout, shapes, storage types and
whether the declarations are internally consistent. It does not establish the
tensor values, numeric equality between two files, how a runtime will place a
tensor, or model behavior. `header_sha256` digests the header bytes only;
`--sha256` performs a separate full read for a file digest and reports those
bytes as `hashing_pass_bytes`, apart from `payload_bytes_read`.

`architecture.derived` restates arithmetic on declared values, for example
`query_heads_per_kv_head`. `quantization.mixed_roles` lists tensor roles whose
storage type differs across blocks. Neither is a quality judgement.

## Limits

16 MiB of descriptor bytes, 65,536 tensors, 65,536 metadata fields, 16
dimensions (4 for GGUF), array nesting depth 8 and 1,000,000 array elements in
total. ONNX adds 262,144 operators and subgraph depth 8; its descriptor budget
counts bytes parsed, not payload skipped. A reached limit returns `complete: false` with `incomplete.reason`, the
offset and the last verified descriptor. So does an unsupported layout such as
big-endian GGUF. A file whose identity, size or timestamps change during the
read is reported with `FILE_CHANGED`.

Buffered GGUF reads never extend past the smallest possible encoding of the
descriptors still to be parsed, so no weight byte is read from a well-formed
file.

Exit status: `0` complete and valid, `2` format violations, `3` incomplete, `1`
usage or I/O error.

## Tests and fixtures

```sh
node --test products/weights-xray/test/*.test.mjs
```

`test/fixtures/` was written by the reference `safetensors` 0.8.0, `gguf`
0.19.0 and `onnx` 1.23.2 Python writers. `reference.json` and
`reference-onnx.json` record what the reference readers report about those
files; the tests compare against them without Python. See
`test/fixtures/generate.py` and `generate_onnx.py` to regenerate. Malformed,
sparse, oversized and deeply nested inputs are written by `test/writers.mjs`.

## Measured cost

`node products/weights-xray/benchmark.mjs --runs 5` writes valid sparse
checkpoints and a 64,000-operator ONNX DAG, and inspects each one in five fresh
processes. The DAG has a labeled `bottleneck/Transpose` join, skip connections
and 64 initializers of 256 KiB. Measured on 2026-11-22 on an AMD EPYC-Genoa VM,
pinned to two of its 12 vCPUs with `taskset -c 0,1`, Node 24.18.0. Memory was
not capped at 4 GiB and the page cache was not dropped, so the first run is not
disk-cold.

| File                  | Tensors | Operators | Median ms (first / max) |   Reads | Bytes read | Payload bytes | Peak RSS MiB |
| --------------------- | ------: | --------: | ----------------------: | ------: | ---------: | ------------: | -----------: |
| 1 GiB safetensors     |   1,000 |           |      21.6 (23.3 / 23.9) |       3 |    107,833 |             0 |         63.7 |
| 1 GiB GGUF            |   1,000 |           |      19.0 (17.0 / 22.1) |      20 |     53,045 |             0 |         58.2 |
| 1 GiB safetensors     |  50,000 |           |   582.7 (573.7 / 593.4) |       3 |  5,385,411 |             0 |        235.6 |
| 1 GiB GGUF            |  50,000 |           |   381.9 (381.9 / 387.1) |      27 |  2,739,102 |             0 |        188.5 |
| 100 GiB safetensors   |   1,000 |           |      23.6 (17.0 / 28.9) |       3 |    113,831 |             0 |         64.0 |
| 100 GiB GGUF          |   1,000 |           |      19.1 (27.2 / 31.6) |      20 |     53,045 |             0 |         58.1 |
| 100 GiB safetensors   |  50,000 |           |   599.9 (599.9 / 627.3) |       3 |  5,685,423 |             0 |        248.2 |
| 100 GiB GGUF          |  50,000 |           |   381.8 (381.8 / 416.7) |      27 |  2,739,102 |             0 |        190.9 |
| 18.6 MiB ONNX         |      64 |    64,000 |   787.9 (770.9 / 836.0) |   1,554 |  2,777,543 |         6,410 |        254.8 |
| 18.6 MiB ONNX, strict |      64 |    64,000 |   2,679 (2,697 / 2,697) | 909,335 |  2,766,132 |             0 |        386.7 |

Cost follows descriptor count, not file size. Of the ONNX file's 16 MiB of
initializer payload, buffered mode transferred 6,410 bytes where the operator
list meets the initializers, and strict mode none. Real checkpoints were not
part of this run.
