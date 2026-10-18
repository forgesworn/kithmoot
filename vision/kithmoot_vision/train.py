"""Offline training CLI. Checkpoints are experimental and cannot enable effects."""

import argparse
import json
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from .data import Frames, digest
from .learning import loss, predict
from .model import CameraVision, MobileCameraVision


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--steps", type=int, default=500)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    parser.add_argument("--seed", type=int, default=18)
    parser.add_argument("--architecture", choices=("v1", "mobile-v2"), default="mobile-v2")
    parser.add_argument("--personal", action="store_true", help="Train a private local experiment; never general/public weights")
    args = parser.parse_args()
    if args.steps < 1 or not 1 <= args.batch_size <= 32:
        parser.error("Use at least one step and a batch size between 1 and 32")
    if args.output.exists():
        parser.error("Output directory already exists; do not overwrite an experiment")
    torch.manual_seed(args.seed)
    torch.set_num_threads(2)
    dataset = Frames(args.manifest, "train", personal=args.personal)
    validation = Frames(args.manifest, "validation", personal=args.personal)
    if not len(dataset) or not len(validation):
        parser.error("Independent training and validation data are required")
    model = (MobileCameraVision() if args.architecture == "mobile-v2" else CameraVision()).to(args.device)
    optimiser = torch.optim.AdamW(model.parameters(), lr=0.001)
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True, num_workers=0)
    iterator = iter(loader)
    first = last = 0.0
    for step in range(args.steps):
        try:
            batch = next(iterator)
        except StopIteration:
            iterator = iter(loader)
            batch = next(iterator)
        batch = {key: value.to(args.device) for key, value in batch.items()}
        objective = loss(predict(model, batch, dropout=True), batch)
        if not torch.isfinite(objective):
            raise RuntimeError("Non-finite training loss; checkpoint refused")
        optimiser.zero_grad(set_to_none=True)
        objective.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5)
        optimiser.step()
        last = float(objective.detach())
        if step == 0:
            first = last
        if step == 0 or (step + 1) % 50 == 0 or step + 1 == args.steps:
            print(json.dumps({"step": step + 1, "loss": last}), flush=True)
    model.eval()
    validation_loss = 0.0
    with torch.no_grad():
        for batch in DataLoader(validation, batch_size=args.batch_size, num_workers=0):
            batch = {key: value.to(args.device) for key, value in batch.items()}
            validation_loss += float(loss(predict(model, batch), batch)) * len(batch["rgb"])
    args.output.mkdir(parents=True)
    weights = args.output / "experimental.pt"
    torch.save(model.cpu().state_dict(), weights)
    card = {"architecture": model.architecture, "status": "experimental", "qualified": False,
            "licence": "PRIVATE-PERSONAL" if args.personal else "MIT",
            "scope": "personal" if args.personal else "general",
            "public_release_allowed": not args.personal,
            "held_out_policy": "independent takes; same personal context" if args.personal else "independent subjects, scenes and takes",
            "pretrained_weights": None, "seed": args.seed,
            "torch": torch.__version__, "device": args.device, "steps": args.steps,
            "parameters": sum(p.numel() for p in model.parameters()),
            "manifest_sha256": digest(args.manifest), "weights_sha256": digest(weights),
            "first_training_loss": first, "last_training_loss": last,
            "validation_loss": validation_loss / len(validation),
            "real_camera_acceptance": False,
            "synthetic_only": all(row.get("synthetic", False) for row in dataset.rows + validation.rows)}
    (args.output / "model-card.json").write_text(json.dumps(card, indent=2) + "\n")
    print(json.dumps(card), flush=True)


if __name__ == "__main__":
    main()
