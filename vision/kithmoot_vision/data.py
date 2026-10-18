"""Offline, reviewed data manifests. Licensing declarations require human review;
checking them here is a reproducibility gate, not proof of anyone's rights.
"""

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_manifest(path: Path, *, personal: bool = False) -> list[dict]:
    root = path.resolve().parent
    records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not records:
        raise ValueError("Empty data manifest")
    ids: set[str] = set()
    partitions: dict[tuple[str, str], str] = {}
    assets: dict[str, str] = {}
    for row in records:
        if row["id"] in ids:
            raise ValueError("Duplicate example id")
        ids.add(row["id"])
        if row["split"] not in {"train", "validation", "test"}:
            raise ValueError("Unknown split")
        if (row["scope"] == "personal") != personal or row["scope"] not in {"general", "personal"}:
            raise ValueError("Personal recordings cannot enter general model training")
        rights = row["rights"]
        if rights["licence"] not in {"MIT", "CC0-1.0", "PROJECT-OWNED"}:
            raise ValueError("Unreviewed or restricted training-data licence")
        if not all(rights.get(key) is True for key in ("training", "commercial", "mit_weights")):
            raise ValueError("Data does not permit commercial MIT model releases")
        evidence = asset_path(root, rights["evidence"])
        if not evidence.is_file() or not evidence.stat().st_size:
            raise ValueError("Missing rights review evidence")
        if digest(evidence) != rights["evidence_sha256"]:
            raise ValueError("Rights review evidence checksum mismatch")
        if not row.get("synthetic", False) and rights.get("subject_permission") is not True:
            raise ValueError("Real people require documented permission review")
        if not row.get("rgb") or not row.get("alpha"):
            raise ValueError("A training example needs an image and a foreground label")
        for kind, groups in (("subject", row["subjects"]), ("scene", [row["scene"]]),
                             ("sequence", [row["sequence"]])):
            for group in groups:
                if not isinstance(group, str) or not group:
                    raise ValueError("Missing split group")
                key = (kind, group)
                if key in partitions and partitions[key] != row["split"]:
                    raise ValueError(f"{kind} leaks across held-out splits")
                partitions[key] = row["split"]
        for name in ("rgb", "alpha", "reference", "previous_alpha", "held_objects"):
            item = row.get(name)
            if item is None:
                continue
            target = asset_path(root, item["path"])
            if not target.is_file() or target.stat().st_size > 64 * 1024 * 1024:
                raise ValueError("Missing or oversized image asset")
            sha = digest(target)
            if sha != item["sha256"]:
                raise ValueError("Training asset checksum mismatch")
            if name == "rgb":
                if sha in assets and assets[sha] != row["split"]:
                    raise ValueError("Identical pictures leak across held-out splits")
                assets[sha] = row["split"]
        for box in row["faces"]:
            if len(box) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in box):
                raise ValueError("Invalid face annotation")
            x, y, w, h = box
            if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1.00001 or y + h > 1.00001:
                raise ValueError("Face annotation lies outside the image")
        if row.get("faces_complete") is not True:
            raise ValueError("Every visible face must be annotated, including bystanders")
        if row.get("foreground_includes_held_objects") is not True:
            raise ValueError("Foreground labels must retain held objects")
    return records


def asset_path(root: Path, name: str) -> Path:
    path = (root / name).resolve()
    if not path.is_relative_to(root):
        raise ValueError("Manifest paths must stay inside their data directory")
    return path


class Frames(Dataset):
    def __init__(self, manifest: Path, split: str, size: tuple[int, int] = (160, 96),
                 *, personal: bool = False) -> None:
        self.root = manifest.resolve().parent
        self.rows = [row for row in read_manifest(manifest, personal=personal) if row["split"] == split]
        self.size = size
        if size[0] % 4 or size[1] % 4 or min(size) < 16:
            raise ValueError("Training dimensions must be multiples of four, at least 16")

    def __len__(self) -> int:
        return len(self.rows)

    def _image(self, row: dict, key: str, channels: int) -> torch.Tensor:
        if row.get(key) is None:
            return torch.zeros(channels, self.size[1], self.size[0])
        with Image.open(asset_path(self.root, row[key]["path"])) as raw:
            if raw.width * raw.height > 16_000_000:
                raise ValueError("Training image is too large")
            image = raw.convert("RGB" if channels == 3 else "L").resize(self.size, Image.Resampling.BILINEAR)
            array = np.asarray(image, dtype=np.float32).copy() / 255
        if channels == 1:
            array = array[:, :, None]
        return torch.from_numpy(array).permute(2, 0, 1)

    def __getitem__(self, index: int) -> dict:
        row = self.rows[index]
        width, height = self.size
        heat = torch.zeros(1, height // 4, width // 4)
        boxes = torch.zeros(4, height // 4, width // 4)
        for x, y, w, h in row["faces"]:
            cx, cy = (x + w / 2) * width / 4, (y + h / 2) * height / 4
            ix, iy = min(int(cx), width // 4 - 1), min(int(cy), height // 4 - 1)
            if heat[0, iy, ix] != 0:
                raise ValueError("Two face centres share one cell; increase training resolution")
            heat[0, iy, ix] = 1
            boxes[:, iy, ix] = torch.tensor([cx - ix, cy - iy, w, h])
        return {"rgb": self._image(row, "rgb", 3), "reference": self._image(row, "reference", 3),
                "reference_valid": torch.full((1, height, width), float(row.get("reference") is not None)),
                "previous_alpha": self._image(row, "previous_alpha", 1),
                "alpha": self._image(row, "alpha", 1), "face_heat": heat, "face_boxes": boxes}
