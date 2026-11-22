"""Write the ONNX fixtures with the reference onnx package and record what its
reader reports about them in reference-onnx.json.

    uv venv /tmp/wx && VIRTUAL_ENV=/tmp/wx uv pip install onnx==1.23.2 numpy==2.5.5
    /tmp/wx/bin/python -I generate_onnx.py OUTPUT_DIR

The external data file weights.bin is intentionally not written: the reader
must report the reference without opening it.
"""

import json
import os
import sys
from importlib.metadata import version

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

out = sys.argv[1]
rng = np.random.default_rng(20261122)

conv_w = numpy_helper.from_array(rng.standard_normal((4, 3, 3, 3)).astype(np.float32), "conv.weight")
conv_b = numpy_helper.from_array(np.zeros(4, dtype=np.float32), "conv.bias")
proj = numpy_helper.from_array(rng.standard_normal((4, 16)).astype(np.float32), "proj.weight")
shape = numpy_helper.from_array(np.array([-1, 4], dtype=np.int64), "shape")

then_branch = helper.make_graph(
    [helper.make_node("FastGelu", ["projected"], ["gelu"], name="gelu", domain="com.example")],
    "then",
    [],
    [helper.make_tensor_value_info("gelu", TensorProto.FLOAT, None)],
)
else_branch = helper.make_graph(
    [helper.make_node("Identity", ["projected"], ["same"], name="identity")],
    "else",
    [],
    [helper.make_tensor_value_info("same", TensorProto.FLOAT, None)],
)
nodes = [
    helper.make_node("Conv", ["pixels", "conv.weight", "conv.bias"], ["conv"], name="conv", pads=[1, 1, 1, 1]),
    helper.make_node("Relu", ["conv"], ["relu"], name="relu"),
    helper.make_node("Transpose", ["relu"], ["nhwc"], name="to_nhwc", perm=[0, 2, 3, 1]),
    helper.make_node("Constant", [], ["shape"], name="shape_const", value=shape),
    helper.make_node("Reshape", ["nhwc", "shape"], ["flat"], name="flatten"),
    helper.make_node("MatMul", ["flat", "proj.weight"], ["projected"], name="project"),
    helper.make_node("If", ["use_gelu"], ["logits"], name="choose", then_branch=then_branch, else_branch=else_branch),
]
graph = helper.make_graph(
    nodes,
    "tiny-vision",
    [
        helper.make_tensor_value_info("pixels", TensorProto.FLOAT, ["batch", 3, 8, 8]),
        helper.make_tensor_value_info("use_gelu", TensorProto.BOOL, []),
    ],
    [helper.make_tensor_value_info("logits", TensorProto.FLOAT, ["rows", 16])],
    initializer=[conv_w, conv_b, proj],
)
gelu = helper.make_function(
    "com.example",
    "FastGelu",
    ["x"],
    ["y"],
    [helper.make_node("Gelu", ["x"], ["y"], approximate="tanh")],
    [helper.make_opsetid("", 20)],
)
model = helper.make_model(
    graph,
    producer_name="weights-xray-fixture",
    producer_version="1",
    opset_imports=[helper.make_opsetid("", 20), helper.make_opsetid("com.example", 1)],
    functions=[gelu],
    doc_string="Fixture model for the ONNX wire reader.",
)
model.ir_version = 10
helper.set_model_props(model, {"license": "MIT", "fixture": "tiny-vision"})
onnx.checker.check_model(model, full_check=True)
# Move proj.weight to an external file that is never written.
external = model.graph.initializer[2]
external.ClearField("raw_data")
external.data_location = TensorProto.EXTERNAL
for key, value in (("location", "weights.bin"), ("offset", "0"), ("length", "256")):
    entry = external.external_data.add()
    entry.key, entry.value = key, value
onnx.save_model(model, os.path.join(out, "tiny-vision.onnx"), save_as_external_data=False)

escape = onnx.ModelProto()
escape.CopyFrom(model)
for t in escape.graph.initializer:
    for e in t.external_data:
        if e.key == "location":
            e.value = "../../outside/weights.bin"
onnx.save_model(escape, os.path.join(out, "escape.onnx"), save_as_external_data=False)


def dims(value_info):
    t = value_info.type.tensor_type
    if not t.HasField("shape"):
        return None
    return [d.dim_value if d.HasField("dim_value") else ({"param": d.dim_param} if d.HasField("dim_param") else None) for d in t.shape.dim]


def graph_facts(g, gid, acc):
    for i, n in enumerate(g.node):
        nid = f"{gid}/n{i}"
        acc["nodes"][nid] = {
            "name": n.name,
            "op_type": n.op_type,
            "domain": n.domain,
            "inputs": list(n.input),
            "outputs": list(n.output),
            "attributes": {a.name: onnx.AttributeProto.AttributeType.Name(a.type) for a in n.attribute},
        }
        for a in n.attribute:
            if a.type == onnx.AttributeProto.GRAPH:
                graph_facts(a.g, f"{nid}/{a.name}", acc)
    for t in g.initializer:
        acc["initializers"][t.name] = {
            "graph": gid,
            "data_type": TensorProto.DataType.Name(t.data_type),
            "dims": list(t.dims),
            "data_location": TensorProto.DataLocation.Name(t.data_location),
            "external_data": {e.key: e.value for e in t.external_data},
            "raw_bytes": len(t.raw_data),
        }
    acc["graphs"][gid] = {
        "name": g.name,
        "inputs": {v.name: {"elem_type": TensorProto.DataType.Name(v.type.tensor_type.elem_type), "shape": dims(v)} for v in g.input},
        "outputs": {v.name: {"elem_type": TensorProto.DataType.Name(v.type.tensor_type.elem_type), "shape": dims(v)} for v in g.output},
    }


loaded = onnx.load(os.path.join(out, "tiny-vision.onnx"), load_external_data=False)
facts = {"nodes": {}, "initializers": {}, "graphs": {}}
graph_facts(loaded.graph, "g0", facts)
facts.update(
    {
        "ir_version": loaded.ir_version,
        "producer_name": loaded.producer_name,
        "opset_import": [{"domain": o.domain, "version": o.version} for o in loaded.opset_import],
        "metadata_props": {p.key: p.value for p in loaded.metadata_props},
        "functions": [{"domain": f.domain, "name": f.name, "nodes": len(f.node)} for f in loaded.functions],
    }
)
with open(os.path.join(out, "reference-onnx.json"), "w") as f:
    json.dump({"generator": {"onnx": version("onnx"), "numpy": version("numpy")}, "tiny-vision.onnx": facts}, f, indent=2, sort_keys=True)
    f.write("\n")
