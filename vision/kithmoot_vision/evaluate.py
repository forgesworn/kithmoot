"""Report held-out face and held-object performance. Never marks a model ready."""

import argparse
import json
from pathlib import Path

import torch

from .data import Frames, digest
from .decode import decode
from .learning import predict
from .model import CameraVision, model_for


def iou(a: tuple | list, b: tuple | list) -> float:
    x, y = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    overlap = max(0, right - x) * max(0, bottom - y)
    return overlap / max(1e-9, a[2] * a[3] + b[2] * b[3] - overlap)


def evaluate_mode(model: CameraVision, frames: Frames, *, use_reference: bool) -> dict:
    hits = total = false_positives = retained = object_pixels = unusable = 0
    matte_iou = 0.0
    with torch.no_grad():
        for index, row in enumerate(frames.rows):
            batch = {key: value[None] for key, value in frames[index].items()}
            # Single-frame metrics never receive a ground-truth previous matte.
            # Sequential temporal evaluation remains a separate release gate.
            batch["previous_alpha"].zero_()
            if not use_reference:
                batch["reference_valid"].zero_()
            output = predict(model, batch)
            detection = decode(output["face_logits"][0], output["face_boxes"][0])
            unusable += not detection.usable
            remaining = list(detection.faces)
            for target in row["faces"]:
                total += 1
                if remaining:
                    best = max(range(len(remaining)), key=lambda i: iou(target, remaining[i]))
                    if iou(target, remaining[best]) >= 0.5:
                        hits += 1
                        remaining.pop(best)
            false_positives += len(remaining)
            alpha = output["alpha_logits"][0].sigmoid() >= 0.5
            target = batch["alpha"][0] >= 0.5
            union = (alpha | target).sum().item()
            matte_iou += (alpha & target).sum().item() / max(1, union) if union else 1.0
            if row.get("held_objects"):
                objects = frames._image(row, "held_objects", 1) >= 0.5
                retained += (alpha & objects).sum().item()
                object_pixels += objects.sum().item()
    return {"frames": len(frames), "faces": total, "matched_faces_iou_0_5": hits,
            "face_recall": hits / total if total else None, "false_positive_faces": false_positives,
            "unusable_detection_frames": unusable, "mean_foreground_iou": matte_iou / len(frames),
            "held_object_pixels": object_pixels,
            "held_object_recall": retained / object_pixels if object_pixels else None,
            "real_camera_acceptance": False}


def evaluate(weights: Path, manifest: Path) -> dict:
    torch.set_num_threads(2)
    card = json.loads((weights.parent / "model-card.json").read_text())
    if card["weights_sha256"] != digest(weights):
        raise ValueError("Checkpoint provenance mismatch")
    model = model_for(card["architecture"]).eval()
    model.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True))
    frames = Frames(manifest, "test", personal=card.get("scope") == "personal")
    if not len(frames):
        raise ValueError("Held-out test data required")
    return {"status": "experimental", "qualified": False,
            "scope": card.get("scope", "general"),
            "held_out_policy": card.get("held_out_policy", "independent subjects, scenes and takes"),
            "weights_sha256": digest(weights), "test_manifest_sha256": digest(manifest),
            "synthetic_only": all(row.get("synthetic", False) for row in frames.rows),
            "evaluation": "single frames; no ground-truth temporal input",
            "without_setup": evaluate_mode(model, frames, use_reference=False),
            "with_optional_reference": evaluate_mode(model, frames, use_reference=True),
            "real_camera_acceptance": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("weights", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    print(json.dumps(evaluate(args.weights, args.manifest), indent=2))
