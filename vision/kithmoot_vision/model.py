"""An experimental learned model, initialised from scratch.

Faces use only the current RGB image. Matting additionally accepts an optional
empty-room reference and previous alpha. Neither reference is a prerequisite.
The matte target includes people AND objects they bring into the foreground.
This architecture has not been qualified on real cameras.
"""

import torch
from torch import Tensor, nn
from torch.nn import functional as F


def conv(inputs: int, outputs: int, stride: int = 1) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(inputs, outputs, 3, stride, 1), nn.ReLU())


class CameraVision(nn.Module):
    architecture = "kithmoot-camera-vision-experimental-v1"

    def __init__(self) -> None:
        super().__init__()
        self.encoder = nn.Sequential(conv(3, 16, 2), conv(16, 24, 2), conv(24, 32))
        self.face_features = conv(32, 24)
        self.face_heatmap = nn.Conv2d(24, 1, 1)
        # Within-cell centre offsets, then normalised width and height.
        self.face_boxes = nn.Conv2d(24, 4, 1)
        self.matte = nn.Sequential(conv(40, 24), conv(24, 16), nn.Conv2d(16, 1, 1))
        nn.init.constant_(self.face_heatmap.bias, -4.0)

    def forward(self, rgb: Tensor, reference: Tensor, reference_valid: Tensor,
                previous_alpha: Tensor) -> dict[str, Tensor]:
        features = self.encoder(rgb)
        face = self.face_features(features)
        # Invalid reference pixels are zeroed even if a caller supplies stale RGB.
        context = torch.cat((rgb, reference * reference_valid, reference_valid,
                             previous_alpha, F.interpolate(features, size=rgb.shape[-2:],
                                                           mode="bilinear", align_corners=False)), 1)
        return {"alpha_logits": self.matte(context),
                "face_logits": self.face_heatmap(face),
                "face_boxes": self.face_boxes(face).sigmoid()}


class MatteAdapter(nn.Module):
    """Small local residual; cannot change face predictions or erase an object
    that the base model confidently retained. Initialise to the base result.
    """

    def __init__(self) -> None:
        super().__init__()
        self.layers = nn.Sequential(conv(7, 8), nn.Conv2d(8, 1, 1))
        nn.init.zeros_(self.layers[-1].weight)
        nn.init.zeros_(self.layers[-1].bias)

    def forward(self, rgb: Tensor, reference: Tensor, base_alpha: Tensor) -> Tensor:
        residual = self.layers(torch.cat((rgb, reference, base_alpha), 1)).tanh() * 0.1
        # This bound limits damage; it does not prove that the base matte is right.
        return (base_alpha + residual).clamp(0, 1)


class MobileCameraVision(CameraVision):
    """Same face branch and input resolution; separable foreground head.
    A different architecture requires separately trained/qualified weights.
    """
    architecture = "kithmoot-camera-vision-experimental-v2"

    def __init__(self) -> None:
        super().__init__()
        self.matte = nn.Sequential(
            nn.Conv2d(40, 40, 3, padding=1, groups=40), nn.ReLU(),
            nn.Conv2d(40, 24, 1), nn.ReLU(),
            nn.Conv2d(24, 24, 3, padding=1, groups=24), nn.ReLU(),
            nn.Conv2d(24, 16, 1), nn.ReLU(), nn.Conv2d(16, 1, 1))


def model_for(architecture: str) -> CameraVision:
    if architecture == CameraVision.architecture:
        return CameraVision()
    if architecture == MobileCameraVision.architecture:
        return MobileCameraVision()
    raise ValueError("Unknown owned model architecture")
