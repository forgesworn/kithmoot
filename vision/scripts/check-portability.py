"""Compare the trained Python graph to our native C ABI; write synthetic
vectors for the separate WASM parity check. Does not qualify model accuracy.
"""

import argparse
import ctypes
import json
from pathlib import Path

import numpy as np
import torch

from kithmoot_vision.export import encode
from kithmoot_vision.decode import decode
from kithmoot_vision.model import model_for


def check(library: Path, checkpoint: Path, output: Path) -> None:
    torch.set_num_threads(2)
    card = json.loads((checkpoint.parent / "model-card.json").read_text())
    model = model_for(card["architecture"]).eval()
    model.load_state_dict(torch.load(checkpoint, map_location="cpu", weights_only=True))
    blob = encode(model)
    api = ctypes.CDLL(str(library.resolve()))
    handle = ctypes.c_void_p
    integer = ctypes.c_size_t
    u32 = ctypes.c_uint32
    api.kv_create.argtypes = [ctypes.c_void_p, integer, integer, integer]
    api.kv_create.restype = handle
    api.kv_free.argtypes = [handle]
    for name in ("kv_input_ptr", "kv_output_ptr"):
        getattr(api, name).argtypes = [handle, u32]
        getattr(api, name).restype = ctypes.POINTER(ctypes.c_float)
    for name in ("kv_input_len", "kv_output_len"):
        getattr(api, name).argtypes = [handle, u32]
        getattr(api, name).restype = integer
    api.kv_run.argtypes = [handle, u32]
    api.kv_run.restype = u32
    api.kv_faces_usable.argtypes = [handle]
    api.kv_faces_usable.restype = u32
    width, height = 32, 24
    engine = api.kv_create(ctypes.c_char_p(blob), len(blob), width, height)
    if not engine:
        raise RuntimeError("Native engine rejected our own export")
    rng = np.random.default_rng(18)
    rgb = rng.random((1, 3, height, width), dtype=np.float32)
    reference = rng.random(rgb.shape, dtype=np.float32)
    previous = rng.random((1, 1, height, width), dtype=np.float32)
    cases = []
    try:
        for flags in (0, 1, 2, 3):
            for kind, values in enumerate((rgb, reference, previous)):
                size = api.kv_input_len(engine, kind)
                np.copyto(np.ctypeslib.as_array(api.kv_input_ptr(engine, kind), shape=(size,)), values.reshape(-1))
            with torch.no_grad():
                result = model(torch.from_numpy(rgb), torch.from_numpy(reference),
                               torch.full((1, 1, height, width), float(bool(flags & 1))),
                               torch.from_numpy(previous) if flags & 2 else torch.zeros_like(torch.from_numpy(previous)))
            expected = [result["alpha_logits"].sigmoid().numpy().reshape(-1),
                        result["face_logits"].numpy().reshape(-1), result["face_boxes"].numpy().reshape(-1)]
            faces = decode(result["face_logits"][0], result["face_boxes"][0])
            if api.kv_run(engine, flags) != 1:
                raise RuntimeError("Native inference failed")
            errors = []
            for kind, wanted in enumerate(expected):
                actual = np.ctypeslib.as_array(api.kv_output_ptr(engine, kind), shape=(api.kv_output_len(engine, kind),))
                np.testing.assert_allclose(actual, wanted, atol=0.0003, rtol=0.0003)
                errors.append(float(np.max(np.abs(actual - wanted))))
            decoded = np.ctypeslib.as_array(api.kv_output_ptr(engine, 3), shape=(api.kv_output_len(engine, 3),))
            assert bool(api.kv_faces_usable(engine)) == faces.usable
            np.testing.assert_allclose(decoded, np.array(faces.faces).reshape(-1), atol=0.0003, rtol=0.0003)
            cases.append({"flags": flags, "expected": [v.tolist() for v in expected], "native_max_errors": errors,
                          "faces": faces.faces, "faces_usable": faces.usable})
    finally:
        api.kv_free(engine)
    output.write_text(json.dumps({"width": width, "height": height, "rgb": rgb.reshape(-1).tolist(),
                                  "reference": reference.reshape(-1).tolist(), "previousAlpha": previous.reshape(-1).tolist(), "cases": cases}))
    output.with_suffix(".kvm").write_bytes(blob)
    print(json.dumps({"native_parity": "passed", "cases": [{"flags": c["flags"], "max_errors": c["native_max_errors"]} for c in cases]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library", type=Path)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    check(args.library, args.checkpoint, args.output)
