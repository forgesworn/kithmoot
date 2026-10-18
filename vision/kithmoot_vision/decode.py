"""Decode every confident face; overflow is an unusable result, never a
silently truncated list that a privacy renderer could mistake for complete.
"""

from dataclasses import dataclass

import torch
from torch import Tensor
from torch.nn import functional as F


@dataclass(frozen=True)
class Detection:
    faces: list[tuple[float, float, float, float]]
    usable: bool


def decode(logits: Tensor, boxes: Tensor, threshold: float = 0.5,
           max_faces: int = 32) -> Detection:
    if logits.ndim != 3 or logits.shape[0] != 1 or boxes.shape != (4, *logits.shape[1:]):
        return Detection([], False)
    if not torch.isfinite(logits).all() or not torch.isfinite(boxes).all():
        return Detection([], False)
    if not 0 < threshold < 1 or max_faces < 1 or (boxes < 0).any() or (boxes > 1).any():
        return Detection([], False)
    scores = logits.sigmoid()
    peaks = (scores == F.max_pool2d(scores[None], 3, 1, 1)[0]) & (scores >= threshold)
    cells = torch.nonzero(peaks[0], as_tuple=False)
    if len(cells) == 0 or len(cells) > max_faces:
        return Detection([], False)
    height, width = logits.shape[1:]
    found = []
    for y, x in cells.tolist():
        dx, dy, w, h = boxes[:, y, x].tolist()
        cx, cy = (x + dx) / width, (y + dy) / height
        left, top = max(0.0, cx - w / 2), max(0.0, cy - h / 2)
        right, bottom = min(1.0, cx + w / 2), min(1.0, cy + h / 2)
        if right <= left or bottom <= top:
            return Detection([], False)
        found.append((left, top, right - left, bottom - top))
    return Detection(found, True)
