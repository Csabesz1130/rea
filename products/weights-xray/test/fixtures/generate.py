"""Write the Weights X-Ray fixtures with the reference writers and record what
the reference readers report about them in reference.json.

The Node tests never run Python. They compare REA's readers with
reference.json. Regenerate with the pinned versions below:

    uv venv /tmp/wx && VIRTUAL_ENV=/tmp/wx uv pip install \
        safetensors==0.8.0 gguf==0.19.0 numpy==2.5.5
    /tmp/wx/bin/python -I generate.py OUTPUT_DIR
"""

import json
import os
import sys
from importlib.metadata import version

import numpy as np
from gguf import GGMLQuantizationType, GGUFReader, GGUFValueType, GGUFWriter
from safetensors import safe_open
from safetensors.numpy import save_file

out = sys.argv[1]
os.makedirs(os.path.join(out, "sharded"), exist_ok=True)
rng = np.random.default_rng(20261122)


def weights(*shape, dtype=np.float32):
    return rng.standard_normal(shape).astype(dtype)


# A base model and a fine-tune with one known change of each kind.
base = {
    "model.embed_tokens.weight": weights(16, 8),
    "model.layers.0.self_attn.q_proj.weight": weights(8, 8),
    "model.layers.0.self_attn.k_proj.weight": weights(4, 8),
    "model.layers.0.mlp.up_proj.weight": weights(12, 8),
    "model.layers.1.mlp.up_proj.weight": weights(12, 8),
    "model.norm.weight": weights(8),
    "lm_head.weight": weights(16, 8),
    "model.removed_in_tuned": weights(2, 2),
}
tuned = dict(base)
del tuned["model.removed_in_tuned"]
tuned["model.embed_tokens.weight"] = weights(18, 8)  # vocabulary grew
tuned["lm_head.weight"] = weights(18, 8)
tuned["model.layers.1.mlp.up_proj.weight"] = base["model.layers.1.mlp.up_proj.weight"].astype(np.float16)
tuned["model.layers.0.self_attn.q_proj.weight"] = base["model.layers.0.self_attn.q_proj.weight"] + 0.01
tuned["model.layers.1.adapter.weight"] = weights(4, 8)
tuned["model.scalar_temperature"] = np.array(0.7, dtype=np.float32)  # scalar
tuned["model.empty_cache"] = np.zeros((0, 8), dtype=np.float32)  # empty tensor
save_file(base, os.path.join(out, "pair-base.safetensors"), metadata={"format": "pt", "revision": "base"})
save_file(tuned, os.path.join(out, "pair-tuned.safetensors"), metadata={"format": "pt", "revision": "tuned"})

# Two shards and their index.
shard_a = {k: base[k] for k in list(base)[:4]}
shard_b = {k: base[k] for k in list(base)[4:]}
names = ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"]
save_file(shard_a, os.path.join(out, "sharded", names[0]), metadata={"format": "pt"})
save_file(shard_b, os.path.join(out, "sharded", names[1]), metadata={"format": "pt"})
total = sum(v.nbytes for v in base.values())
weight_map = {k: names[0] for k in shard_a} | {k: names[1] for k in shard_b}
with open(os.path.join(out, "sharded", "model.safetensors.index.json"), "w") as f:
    json.dump({"metadata": {"total_size": total}, "weight_map": weight_map}, f, indent=2)

# A small GGUF with mixed storage types, typed metadata and a chat template.
gguf_path = os.path.join(out, "tiny-llama.gguf")
w = GGUFWriter(gguf_path, "llama")
w.add_name("tiny-fixture")
w.add_block_count(2)
w.add_context_length(256)
w.add_embedding_length(64)
w.add_feed_forward_length(128)
w.add_head_count(4)
w.add_head_count_kv(2)
w.add_rope_freq_base(10000.0)
w.add_file_type(15)
w.add_tokenizer_model("llama")
w.add_token_list([f"tok{i}" for i in range(20)])
w.add_token_scores([float(i) for i in range(20)])
w.add_chat_template("{% for m in messages %}{% if m.role == 'user' %}{{ m.content }}{% endif %}{% endfor %}")
w.add_array("tiny.nested", [[1, 2], [3, 4, 5]])
w.add_bool("tiny.flag", True)
w.add_uint64("tiny.big", 2**63 + 5)


def quantized(name, rows, cols, qtype, block, size):
    raw = rng.integers(0, 255, size=(rows, cols // block * size), dtype=np.uint8)
    w.add_tensor(name, raw, raw_dtype=qtype)


w.add_tensor("token_embd.weight", weights(20, 64, dtype=np.float16))
for b in range(2):
    quantized(f"blk.{b}.attn_q.weight", 64, 64, GGMLQuantizationType.Q8_0, 32, 34)
    quantized(f"blk.{b}.attn_k.weight", 32, 64, GGMLQuantizationType.Q8_0 if b == 0 else GGMLQuantizationType.Q4_0, 32, 34 if b == 0 else 18)
    quantized(f"blk.{b}.ffn_up.weight", 128, 256, GGMLQuantizationType.Q4_K, 256, 144)
    w.add_tensor(f"blk.{b}.attn_norm.weight", weights(64))
w.add_tensor("output_norm.weight", weights(64))
w.write_header_to_file()
w.write_kv_data_to_file()
w.write_tensors_to_file()
w.close()


def safetensors_facts(path):
    with open(path, "rb") as f:
        n = int.from_bytes(f.read(8), "little")
        header = json.loads(f.read(n))
    facts = {"header_bytes": n, "metadata": header.pop("__metadata__", None), "tensors": {}}
    with safe_open(path, framework="numpy") as f:
        assert sorted(f.keys()) == sorted(header)
        for k in f.keys():
            s = f.get_slice(k)
            facts["tensors"][k] = {
                "dtype": s.get_dtype(),
                "shape": list(s.get_shape()),
                "data_offsets": header[k]["data_offsets"],
            }
    return facts


def gguf_value(field):
    t = field.types[0]
    if t == GGUFValueType.ARRAY:
        return {"array_of": field.types[1].name, "length": len(field.data)}
    if t == GGUFValueType.STRING:
        return str(bytes(field.parts[field.data[0]]), "utf-8")
    return field.parts[field.data[0]].tolist()[0]


r = GGUFReader(gguf_path)
gguf_facts = {
    "version": int(r.fields["GGUF.version"].parts[-1][0]),
    "alignment": r.alignment,
    "data_offset": r.data_offset,
    "metadata": {k: gguf_value(v) for k, v in r.fields.items() if not k.startswith("GGUF.")},
    "tensors": {
        t.name: {
            "type": t.tensor_type.name,
            "shape": [int(x) for x in t.shape],
            "elements": int(t.n_elements),
            "bytes": int(t.n_bytes),
            "file_offset": int(t.data_offset),
        }
        for t in r.tensors
    },
}

reference = {
    "generator": {"safetensors": version("safetensors"), "gguf": version("gguf"), "numpy": version("numpy")},
    "pair-base.safetensors": safetensors_facts(os.path.join(out, "pair-base.safetensors")),
    "pair-tuned.safetensors": safetensors_facts(os.path.join(out, "pair-tuned.safetensors")),
    "tiny-llama.gguf": gguf_facts,
}
with open(os.path.join(out, "reference.json"), "w") as f:
    json.dump(reference, f, indent=2, sort_keys=True)
    f.write("\n")
