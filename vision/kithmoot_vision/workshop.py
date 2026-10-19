"""Import human-reviewed, rights-cleared workshop frames for general training.

This accepts explicit public-model grants, never personal Camera Lab captures.
It has no downloader, upload client, telemetry or automatic rights approval.
"""

import argparse
import base64
import io
import json
import math
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
from PIL import Image

from .data import digest, read_manifest, reviewed_tasks

FORMAT = "kithmoot-model-workshop-v1"
LICENCES = {"MIT", "CC0-1.0", "PROJECT-OWNED", "PUBLIC-DOMAIN-REVIEWED"}


def image(value: str, *, rgb: bool = False, size=None) -> Image.Image:
    prefix = "data:image/png;base64,"
    if not isinstance(value, str) or not value.startswith(prefix) or len(value) > 16_000_000:
        raise ValueError("Workshop pictures must be bounded PNG data URLs")
    try:
        raw = base64.b64decode(value[len(prefix):], validate=True)
        with Image.open(io.BytesIO(raw)) as source:
            if source.format != "PNG" or min(source.size) < 16 or max(source.size) > 2048 or source.width * source.height > 2_000_000:
                raise ValueError("Workshop picture exceeds the reviewed image limits")
            if size is not None and source.size != size:
                raise ValueError("Labels must match their source picture dimensions")
            return source.convert("RGB" if rgb else "L")
    except (OSError, TypeError) as error:
        raise ValueError("Invalid workshop picture") from error


def source_review(source: dict) -> None:
    if not isinstance(source.get("id"), str) or not source["id"] or len(source["id"]) > 160:
        raise ValueError("A source needs a bounded identifier")
    if source.get("status") != "approved" or source.get("licence") not in LICENCES:
        raise ValueError("Pending, rejected or restricted sources cannot enter training")
    for key in ("training", "commercial", "mit_weights", "subject_permission"):
        if source.get(key) is not True:
            raise ValueError("Review training, commercial, MIT-weight and subject rights explicitly")
    for key in ("reviewer", "reviewed_at", "terms", "permission_basis", "scene", "sequence"):
        if not isinstance(source.get(key), str) or not source[key].strip() or len(source[key]) > 24_000:
            raise ValueError("Source review needs reviewer, terms, permission basis and split groups")
    if source["licence"] == "PUBLIC-DOMAIN-REVIEWED" and (not isinstance(source.get("public_domain_basis"), str) or not source["public_domain_basis"].strip()):
        raise ValueError("Record the public-domain basis and geographic scope")
    if urlparse(source.get("url", "")).scheme not in {"http", "https"}:
        raise ValueError("Record the original source or permission-evidence URL")
    if not re.fullmatch(r"[0-9a-f]{64}", source.get("sha256", "")):
        raise ValueError("A source needs its original file SHA-256")
    if (not isinstance(source.get("subjects"), list) or not source["subjects"]
            or any(not isinstance(item, str) or not item.strip() for item in source["subjects"])):
        raise ValueError("Record opaque subject groups, shared across clips of the same people")
    if source.get("split") not in {"train", "validation", "test"}:
        raise ValueError("Assign each source to one independent split")
    if type(source.get("synthetic")) is not bool:
        raise ValueError("Declare whether the source is synthetic")


def import_workshop(paths: list[Path], output: Path) -> Path:
    if output.exists():
        raise ValueError("Use a new output directory; existing data is never overwritten")
    sources, samples, identifiers, bundle_hashes = {}, [], set(), []
    for path in paths:
        if path.stat().st_size > 192 * 1024 * 1024:
            raise ValueError("Workshop bundle is too large")
        bundle = json.loads(path.read_text())
        if bundle.get("format") != FORMAT or bundle.get("scope") != "general" or bundle.get("public_model_permission") is not True:
            raise ValueError("Only explicit general/public-model workshop reviews are accepted")
        bundle_hashes.append(digest(path))
        for source in bundle.get("sources", []):
            source_review(source)
            if source["id"] in sources and source != sources[source["id"]]:
                raise ValueError("Conflicting source reviews")
            sources[source["id"]] = source
        records = bundle.get("samples")
        if not isinstance(records, list) or not 1 <= len(records) <= 24:
            raise ValueError("Export between one and 24 reviewed frames per bundle")
        for record in records:
            if len(samples) >= 256:
                raise ValueError("Import at most 256 reviewed frames per pilot")
            identifier = record.get("id")
            if not isinstance(identifier, str) or not 1 <= len(identifier) <= 160 or identifier in identifiers:
                raise ValueError("Duplicate or invalid frame identifier")
            identifiers.add(identifier)
            if record.get("source") not in sources:
                raise ValueError("A frame has no approved source review")
            tasks = reviewed_tasks(record)
            if tasks["faces"] and record.get("faces_complete") is not True:
                raise ValueError("Review every visible face before importing")
            if tasks["foreground"] and record.get("foreground_reviewed") is not True:
                raise ValueError("Review foreground, hands and held objects before importing")
            faces = record.get("faces", [])
            if not isinstance(faces, list) or len(faces) > 32:
                raise ValueError("Invalid frame face boxes")
            if not tasks["faces"] and faces:
                raise ValueError("Unreviewed face labels cannot be imported")
            for box in faces:
                if not isinstance(box, list) or len(box) != 4 or any(type(v) not in (int, float) or not math.isfinite(v) for v in box):
                    raise ValueError("Invalid face geometry")
                x, y, w, h = box
                if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1.00001 or y + h > 1.00001:
                    raise ValueError("Face box is outside its frame")
            if type(record.get("time")) not in (float, int) or not math.isfinite(record["time"]) or record["time"] < 0:
                raise ValueError("Record a finite source-frame time")
            rgb = image(record["rgb"], rgb=True)
            pictures = {"rgb": rgb}
            if tasks["foreground"]:
                pictures["alpha"] = image(record.get("alpha"), size=rgb.size)
                if record.get("held_objects"):
                    pictures["held_objects"] = image(record["held_objects"], size=rgb.size)
                    objects = np.asarray(pictures["held_objects"]) >= 128
                    if (np.asarray(pictures["alpha"])[objects] < 128).any():
                        raise ValueError("Foreground labels must retain marked opaque held objects")
            elif record.get("alpha") or record.get("held_objects"):
                raise ValueError("Unreviewed foreground labels cannot be imported")
            samples.append((record, pictures))
    if {sources[record["source"]]["split"] for record, _ in samples} != {"train", "validation", "test"}:
        raise ValueError("Collect independent train, validation and held-out test sources")
    output.mkdir(parents=True)
    try:
        evidence = {}
        for index, (identifier, source) in enumerate(sources.items()):
            target = output / f"source-{index:04d}-review.json"
            target.write_text(json.dumps({**source, "bundle_sha256": bundle_hashes}, indent=2) + "\n")
            evidence[identifier] = target
        rows = []
        for index, (record, pictures) in enumerate(samples):
            source = sources[record["source"]]
            tasks = reviewed_tasks(record)
            rights = {key: source[key] for key in ("licence", "training", "commercial", "mit_weights", "subject_permission")}
            rights.update(evidence=evidence[source["id"]].name, evidence_sha256=digest(evidence[source["id"]]))
            if source.get("public_domain_basis"):
                rights["public_domain_basis"] = source["public_domain_basis"]
            row = {"id": record["id"], "scope": "general", "split": source["split"], "labels": tasks,
                   "synthetic": source["synthetic"], "subjects": source["subjects"], "scene": source["scene"],
                   "sequence": source["sequence"], "faces": record.get("faces", []) if tasks["faces"] else [],
                   "faces_complete": tasks["faces"], "foreground_includes_held_objects": tasks["foreground"],
                   "source_file_sha256": source["sha256"], "source_time": record["time"], "rights": rights}
            for name, picture in pictures.items():
                target = output / f"{index:04d}-{name}.png"
                picture.save(target)
                row[name] = {"path": target.name, "sha256": digest(target)}
            rows.append(row)
        manifest = output / "manifest.jsonl"
        manifest.write_text("".join(json.dumps(row) + "\n" for row in rows))
        read_manifest(manifest)
        return manifest
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundles", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(import_workshop(args.bundles, args.output))
