"""Supervised learning and bounded personal matting adaptation, without uploads."""

import torch
from torch import Tensor
from torch.nn import functional as F

from .model import CameraVision, MatteAdapter


def predict(model: CameraVision, batch: dict[str, Tensor], *, dropout: bool = False) -> dict[str, Tensor]:
    reference, valid, previous = batch["reference"], batch["reference_valid"], batch["previous_alpha"]
    if dropout:
        shape = (reference.shape[0], 1, 1, 1)
        # Learn ordinary RGB inference too. Empty-room capture is optional.
        valid = valid * (torch.rand(shape, device=valid.device) > 0.5)
        previous = previous * (torch.rand(shape, device=previous.device) > 0.5)
    return model(batch["rgb"], reference, valid, previous)


def loss(outputs: dict[str, Tensor], batch: dict[str, Tensor]) -> Tensor:
    size = batch["rgb"].shape[0]
    known = torch.ones(size, dtype=torch.bool, device=batch["rgb"].device)
    faces = batch.get("faces_valid", known).bool()
    foreground = batch.get("foreground_valid", known).bool()
    objectives = []
    if faces.any():
        heat, logits = batch["face_heat"][faces], outputs["face_logits"][faces]
        probability = logits.sigmoid()
        # Unlabelled faces never become negative examples. Skip an entire
        # unreviewed branch so AdamW does not decay its private head either.
        weight = torch.where(heat == 1, (1 - probability).square(), probability.square())
        face = (F.binary_cross_entropy_with_logits(logits, heat, reduction="none") * weight).sum() / heat.sum().clamp_min(1)
        geometry = outputs["face_boxes"][faces]
        locations = heat.expand_as(geometry)
        box = (F.smooth_l1_loss(geometry, batch["face_boxes"][faces], reduction="none") * locations).sum() / locations.sum().clamp_min(1)
        objectives.append(face + 5 * box)
    if foreground.any():
        logits, target = outputs["alpha_logits"][foreground], batch["alpha"][foreground]
        alpha = logits.sigmoid()
        matte = F.binary_cross_entropy_with_logits(logits, target)
        edge = (torch.diff(alpha, dim=-1) - torch.diff(target, dim=-1)).abs().mean()
        edge = edge + (torch.diff(alpha, dim=-2) - torch.diff(target, dim=-2)).abs().mean()
        objectives.append(matte + edge)
    if not objectives:
        raise ValueError("A batch needs at least one reviewed task")
    return sum(objectives)


def adapt_step(base: CameraVision, adapter: MatteAdapter, batch: dict[str, Tensor],
               optimiser: torch.optim.Optimizer) -> float:
    """Train only an adapter against reviewed local matte labels. Empty-room
    frames have alpha zero. Occupied recordings need reviewed labels or a
    qualified teacher; image differences are not ground-truth foreground.
    The caller owns deletion, checkpoint qualification and validation rollback.
    """
    with torch.no_grad():
        alpha = predict(base, batch)["alpha_logits"].sigmoid()
    adapted = adapter(batch["rgb"], batch["reference"] * batch["reference_valid"], alpha)
    objective = F.l1_loss(adapted, batch["alpha"]) + 0.1 * F.l1_loss(adapted, alpha)
    optimiser.zero_grad(set_to_none=True)
    objective.backward()
    optimiser.step()
    return float(objective.detach())
