"""Import reviewed camera-lab exports for private local experiments only.

No downloads, automatic labelling or public-training permission. All output
paths are generated here; imported filenames cannot escape the new directory.
"""

import argparse
import base64
import io
import json
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

from .data import digest, read_manifest


def picture(value: str, *, size=None, colour=False) -> Image.Image:
    prefix = "data:image/png;base64,"
    if not isinstance(value, str) or not value.startswith(prefix) or len(value) > 2_000_000:
        raise ValueError("Capture images must be bounded PNG data URLs")
    raw = base64.b64decode(value[len(prefix):], validate=True)
    with Image.open(io.BytesIO(raw)) as image:
        w, h = image.size
        if image.format != "PNG" or min(w, h) < 16 or max(w, h) > 512 or w * h > 65_536:
            raise ValueError("Invalid capture image dimensions")
        if size is not None and image.size != size:
            raise ValueError("Capture labels/reference must match the picture")
        return image.convert("RGB" if colour else "L")


def import_captures(paths: list[Path], output: Path) -> Path:
    if output.exists():
        raise ValueError("Output already exists; never overwrite personal captures")
    samples = []
    ids = set()
    for path in paths:
        if path.stat().st_size > 48 * 1024 * 1024:
            raise ValueError("Capture bundle too large")
        bundle = json.loads(path.read_text())
        if bundle.get("format") != "kithmoot-vision-captures-v1" or bundle.get("scope") != "personal":
            raise ValueError("Only personal camera-lab bundles are accepted")
        records = bundle.get("samples")
        if not isinstance(records, list) or not 1 <= len(records) <= 32:
            raise ValueError("Capture bundle needs between one and 32 samples")
        for record in records:
            if len(samples) >= 128:
                raise ValueError("Import at most 128 reviewed samples per experiment")
            if not all(record.get(key) is True for key in ("facesComplete", "foregroundReviewed", "permissionReviewed")):
                raise ValueError("Review faces, foreground/held objects and local permission first")
            if record.get("split") not in {"train", "validation", "test"}:
                raise ValueError("Unknown capture split")
            for key in ("id", "sequence"):
                if not isinstance(record.get(key), str) or not 1 <= len(record[key]) <= 160:
                    raise ValueError("Capture requires bounded example and take IDs")
            if record["id"] in ids:
                raise ValueError("Duplicate captured example")
            ids.add(record["id"])
            faces = record.get("faces")
            if not isinstance(faces, list) or len(faces) > 32:
                raise ValueError("Invalid captured face boxes")
            for box in faces:
                if not isinstance(box, list) or len(box) != 4 or not all(
                    type(v) in (int, float) and math.isfinite(v) for v in box
                ):
                    raise ValueError("Invalid captured face box")
                x, y, w, h = box
                if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1.00001 or y + h > 1.00001:
                    raise ValueError("Captured face is outside its picture")
            rgb = picture(record["rgb"], colour=True)
            images = {"rgb": rgb, "alpha": picture(record["alpha"], size=rgb.size)}
            for key in ("reference", "held_objects"):
                if record.get(key):
                    images[key] = picture(record[key], size=rgb.size, colour=key == "reference")
            if "held_objects" in images:
                objects = np.asarray(images["held_objects"]) >= 128
                if (np.asarray(images["alpha"])[objects] < 128).any():
                    raise ValueError("Held objects must be retained in the foreground label")
            samples.append((record, images))
    if {r["split"] for r, _ in samples} != {"train", "validation", "test"}:
        raise ValueError("Collect independent training, validation and test takes")
    output.mkdir(parents=True)  # Exclusive creation; only our new directory is cleaned on failure.
    try:
        review = output / "local-permission-review.json"
        review.write_text(json.dumps({"scope": "personal-local-only", "public_release_permission": False,
                                     "declarations": "The lab operator reviewed local recording/training permission and every label.",
                                     "capture_bundle_sha256": [digest(p) for p in paths]}, indent=2) + "\n")
        rows = []
        for index, (record, images) in enumerate(samples):
            row = {"id": record["id"], "scope": "personal", "split": record["split"],
                   "subjects": ["local-participants"], "scene": "personal-context", "sequence": record["sequence"],
                   "synthetic": record.get("synthetic") is True, "faces": record["faces"],
                   "faces_complete": True, "foreground_includes_held_objects": True,
                   "rights": {"licence": "PERSONAL-LOCAL", "training": True, "personal_only": True,
                              "subject_permission": True, "commercial": False, "mit_weights": False,
                              "evidence": review.name, "evidence_sha256": digest(review)}}
            for name, image in images.items():
                target = output / f"{index:04d}-{name}.png"
                image.save(target)
                row[name] = {"path": target.name, "sha256": digest(target)}
            rows.append(row)
        manifest = output / "manifest.jsonl"
        manifest.write_text("".join(json.dumps(row) + "\n" for row in rows))
        read_manifest(manifest, personal=True)  # Includes take and identical-picture leakage checks.
        return manifest
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("captures", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(import_captures(args.captures, args.output))
