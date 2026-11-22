# Weights X-Ray

Read the tensor inventory of a local model file without loading its weights.
`rea weights inspect` reports every tensor's name, shape, storage type, byte
extent and the file bytes of the descriptor that declared it. It reads the
header and descriptor table only and counts every byte it reads.

```sh
rea weights inspect ./model.safetensors
rea weights inspect ./model.safetensors.index.json --limit 0
rea weights inspect ./model-Q4_K_M.gguf --offset 100 --limit 50
```

It runs nothing from the file, renders no template and loads no framework.

## Formats

| Input                          | Verified                                                                                                                                   | Reported                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.safetensors`                 | Eight-byte header length, strict UTF-8 JSON (duplicate keys rejected), dtype × shape = byte length, contiguous coverage of the data region | Tensors, `__metadata__`, dtype totals, parameter count, header SHA-256                                                                               |
| `model.safetensors.index.json` | Each shard is a regular sibling file; every `weight_map` entry against the shard that stores it; `metadata.total_size`                     | Per-shard results, missing, mismapped, unmapped and conflicting tensors                                                                              |
| `.gguf` v2/v3, little-endian   | Typed key/value metadata, tensor descriptors, alignment, block divisibility, aligned offsets, bounds and overlap                           | Metadata (long strings and arrays by preview and digest), architecture hyperparameters, storage types by tensor role, chat-template statement counts |

Storage sizes come from pinned tables: the safetensors `Dtype` enum and gguf-py
0.19.0 `GGML_QUANT_SIZES`. A type outside the table gets `storage: "unknown"`
and a warning rather than a guessed extent. Q8_1 is reported that way on
purpose: it is a dot-product intermediate and the Python table (40 bytes per
block) disagrees with ggml's `block_q8_1` (36). Sub-byte safetensors dtypes
(`F4`, `F6_*`) are sized by bit count and marked `packing: "sub-byte"`.

GGUF axis order is preserved as declared (`ne0` first), as gguf-py reports it.
64-bit quantities are JSON numbers when exact and decimal strings otherwise.

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
total. A reached limit returns `complete: false` with `incomplete.reason`, the
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

`test/fixtures/` was written by the reference `safetensors` 0.8.0 and `gguf`
0.19.0 Python writers. `reference.json` records what the reference readers
report about those files; the tests compare against it without Python. See
`test/fixtures/generate.py` to regenerate. Malformed, sparse and oversized
inputs are written by `test/writers.mjs`.

## Measured cost

`node products/weights-xray/benchmark.mjs --runs 5` writes valid sparse
checkpoints and inspects each one in five fresh processes. Measured on
2026-11-22 on an AMD EPYC-Genoa VM, pinned to two of its 12 vCPUs with
`taskset -c 0,1`, Node 24.18.0. Memory was not capped at 4 GiB and the page
cache was not dropped, so the first run is not disk-cold.

| File                | Tensors | Median ms (first / max) | Reads | Bytes read | Payload bytes | Peak RSS MiB |
| ------------------- | ------: | ----------------------: | ----: | ---------: | ------------: | -----------: |
| 1 GiB safetensors   |   1,000 |      25.6 (28.7 / 34.1) |     3 |    107,833 |             0 |         64.0 |
| 1 GiB GGUF          |   1,000 |      18.9 (18.8 / 29.2) |    20 |     53,045 |             0 |         57.3 |
| 1 GiB safetensors   |  50,000 |   592.4 (586.7 / 605.6) |     3 |  5,385,411 |             0 |        231.9 |
| 1 GiB GGUF          |  50,000 |   440.1 (440.1 / 540.9) |    27 |  2,739,102 |             0 |        196.4 |
| 100 GiB safetensors |   1,000 |      21.3 (21.3 / 26.5) |     3 |    113,831 |             0 |         63.5 |
| 100 GiB GGUF        |   1,000 |      22.3 (20.0 / 31.5) |    20 |     53,045 |             0 |         57.5 |
| 100 GiB safetensors |  50,000 |   603.8 (587.2 / 632.5) |     3 |  5,685,423 |             0 |        250.1 |
| 100 GiB GGUF        |  50,000 |   444.0 (444.0 / 455.6) |    27 |  2,739,102 |             0 |        192.9 |

Cost follows descriptor count, not file size. Real checkpoints were not part of
this run.
