"""Export our fixed v1 graph weights, without embedding Python or a vendor SDK."""

import argparse
import json
import struct
from pathlib import Path

import numpy as np
import torch

from .data import digest
from .model import CameraVision, MobileCameraVision, model_for


PARAMETERS = 30_086


def encode(model: CameraVision) -> bytes:
    # Rust consumes this version's modules in the same declared layer order.
    expected = ("encoder.0.0", "encoder.1.0", "encoder.2.0", "face_features.0", "face_heatmap", "face_boxes")
    mobile = model.architecture == MobileCameraVision.architecture
    expected += ("matte.0", "matte.2", "matte.4", "matte.6", "matte.8") if mobile else ("matte.0.0", "matte.1.0", "matte.2")
    names = tuple(name for layer in expected for name in (layer + ".weight", layer + ".bias"))
    state = model.state_dict()
    if tuple(state) != names:
        raise ValueError("Architecture changed: update and version the portable graph first")
    values = np.concatenate([state[name].detach().cpu().numpy().reshape(-1) for name in names]).astype("<f4")
    count = 19_974 if mobile else PARAMETERS
    if values.size != count or not np.isfinite(values).all():
        raise ValueError("Invalid model parameters")
    return (b"KVM2" if mobile else b"KVM1") + struct.pack("<I", count) + values.tobytes()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("weights", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    card_path = args.weights.parent / "model-card.json"
    card = json.loads(card_path.read_text())
    if card["weights_sha256"] != digest(args.weights):
        parser.error("Checkpoint provenance mismatch")
    if args.output.exists() or args.output.with_suffix(".json").exists():
        parser.error("Refusing to overwrite an export")
    model = model_for(card["architecture"]).eval()
    model.load_state_dict(torch.load(args.weights, weights_only=True, map_location="cpu"))
    encoded = encode(model)
    args.output.write_bytes(encoded)
    # Export cannot qualify a model or change its recorded release status.
    metadata = {**card, "format": encoded[:4].decode("ascii"), "portable_weights_sha256": digest(args.output),
                "qualified": False, "runtime": "first-party Rust; native and wasm32"}
    args.output.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"bytes": args.output.stat().st_size, "sha256": digest(args.output), "qualified": False}))


if __name__ == "__main__":
    main()
