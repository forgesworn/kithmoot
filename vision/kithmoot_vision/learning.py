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
    heat = batch["face_heat"]
    probability = outputs["face_logits"].sigmoid()
    # Focal weighting prevents the many empty grid cells overwhelming faces.
    weight = torch.where(heat == 1, (1 - probability).square(), probability.square())
    face = (F.binary_cross_entropy_with_logits(outputs["face_logits"], heat, reduction="none") * weight).sum() / heat.sum().clamp_min(1)
    locations = heat.expand_as(outputs["face_boxes"])
    box = (F.smooth_l1_loss(outputs["face_boxes"], batch["face_boxes"], reduction="none") * locations).sum() / locations.sum().clamp_min(1)
    alpha = outputs["alpha_logits"].sigmoid()
    matte = F.binary_cross_entropy_with_logits(outputs["alpha_logits"], batch["alpha"])
    # Edges supervise hair and object boundaries, rather than just region area.
    edge = (torch.diff(alpha, dim=-1) - torch.diff(batch["alpha"], dim=-1)).abs().mean()
    edge = edge + (torch.diff(alpha, dim=-2) - torch.diff(batch["alpha"], dim=-2)).abs().mean()
    return face + 5 * box + matte + edge


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
