"""Bounded offline training with reviewed labels and resumable checkpoints."""

import argparse
import json
import os
from pathlib import Path

import torch
from torch.utils.data import DataLoader, default_collate

from .data import Frames, digest, reviewed_tasks
from .learning import loss, predict
from .model import CameraVision, MobileCameraVision


def rng_state(device: str) -> dict:
    state = {"cpu": torch.get_rng_state()}
    if device == "mps":
        state["mps"] = torch.mps.get_rng_state()
    if device == "cuda":
        state["cuda"] = torch.cuda.get_rng_state_all()
    return state


def restore_rng(state: dict, device: str) -> None:
    torch.set_rng_state(state["cpu"])
    if device == "mps" and "mps" in state:
        torch.mps.set_rng_state(state["mps"])
    if device == "cuda" and "cuda" in state:
        torch.cuda.set_rng_state_all(state["cuda"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--steps", type=int, default=500, help="Total steps, including those in a resumed checkpoint")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    parser.add_argument("--seed", type=int, default=18)
    parser.add_argument("--architecture", choices=("v1", "mobile-v2"), default="mobile-v2")
    parser.add_argument("--personal", action="store_true", help="Private local experiment; never general/public weights")
    parser.add_argument("--resume", type=Path, help="Resume checkpoint.pt into a new output directory")
    parser.add_argument("--checkpoint-every", type=int, default=100)
    args = parser.parse_args()
    if args.steps < 1 or not 1 <= args.batch_size <= 32 or args.checkpoint_every < 1:
        parser.error("Use positive steps/checkpoint interval and a batch size between 1 and 32")
    if args.output.exists():
        parser.error("Output directory already exists; do not overwrite an experiment")
    if args.device == "mps" and not torch.backends.mps.is_available():
        parser.error("Metal/MPS is unavailable; use an Apple Silicon Python/PyTorch environment or select cpu")
    torch.manual_seed(args.seed)
    torch.set_num_threads(2)
    dataset = Frames(args.manifest, "train", personal=args.personal)
    validation = Frames(args.manifest, "validation", personal=args.personal)
    if not len(dataset) or not len(validation):
        parser.error("Independent training and validation data are required")
    def coverage(rows):
        return {task: sum(reviewed_tasks(row)[task] for row in rows) for task in ("faces", "foreground")}
    labelled = {"train": coverage(dataset.rows), "validation": coverage(validation.rows)}
    if any(labelled["train"][task] and not labelled["validation"][task] for task in labelled["train"]):
        parser.error("Each trained task needs independent reviewed validation examples")
    recipe = {"manifest_sha256": digest(args.manifest), "architecture": args.architecture,
              "batch_size": args.batch_size, "seed": args.seed, "personal": args.personal,
              "torch": str(torch.__version__), "device": args.device,
              "source_sha256": {name: digest(Path(__file__).with_name(name))
                                for name in ("train.py", "data.py", "model.py", "learning.py")}}
    model = (MobileCameraVision() if args.architecture == "mobile-v2" else CameraVision()).to(args.device)
    optimiser = torch.optim.AdamW(model.parameters(), lr=0.001)
    generator = torch.Generator().manual_seed(args.seed)
    order, cursor, completed = [], 0, 0
    first = last = 0.0
    resumed = None
    if args.resume:
        checkpoint = torch.load(args.resume, map_location="cpu", weights_only=True)
        if checkpoint.get("format") != "kithmoot-training-checkpoint-v1" or checkpoint.get("recipe") != recipe:
            parser.error("Checkpoint requires the same reviewed dataset, training source, architecture, scope, seed and batch size")
        completed = checkpoint["completed_steps"]
        if args.steps <= completed:
            parser.error("Total steps must exceed the resumed checkpoint's completed steps")
        model.load_state_dict(checkpoint["model"])
        optimiser.load_state_dict(checkpoint["optimiser"])
        generator.set_state(checkpoint["sampler_rng"])
        order, cursor = checkpoint["order"], checkpoint["cursor"]
        first, last = checkpoint["first_loss"], checkpoint["last_loss"]
        restore_rng(checkpoint["rng"], args.device)
        resumed = digest(args.resume)
    args.output.mkdir(parents=True)
    last_saved = completed

    def save_checkpoint() -> None:
        nonlocal last_saved
        payload = {"format": "kithmoot-training-checkpoint-v1", "recipe": recipe,
                   "completed_steps": completed, "model": model.state_dict(), "optimiser": optimiser.state_dict(),
                   "sampler_rng": generator.get_state(), "order": order, "cursor": cursor,
                   "rng": rng_state(args.device), "device": args.device, "first_loss": first, "last_loss": last}
        temporary = args.output / ".checkpoint.pt.tmp"
        torch.save(payload, temporary)
        os.replace(temporary, args.output / "checkpoint.pt")
        last_saved = completed

    save_checkpoint()
    try:
        for step in range(completed, args.steps):
            if cursor >= len(order):
                order = torch.randperm(len(dataset), generator=generator).tolist()
                cursor = 0
            indices = order[cursor:cursor + args.batch_size]
            cursor += len(indices)
            batch = default_collate([dataset[index] for index in indices])
            batch = {key: value.to(args.device) for key, value in batch.items()}
            objective = loss(predict(model, batch, dropout=True), batch)
            if not torch.isfinite(objective):
                raise RuntimeError("Non-finite training loss; model export refused")
            optimiser.zero_grad(set_to_none=True)
            objective.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5)
            optimiser.step()
            last = float(objective.detach())
            if step == 0:
                first = last
            completed = step + 1
            if completed % args.checkpoint_every == 0 or completed == args.steps:
                save_checkpoint()
            if step == 0 or completed % 50 == 0 or completed == args.steps:
                print(json.dumps({"step": completed, "loss": last, "device": args.device}), flush=True)
    except KeyboardInterrupt:
        # The last atomic checkpoint is a completed step; an interrupted
        # optimiser operation must never overwrite it with partial state.
        print(json.dumps({"interrupted": True, "completed_steps": last_saved,
                          "checkpoint": str(args.output / "checkpoint.pt")}), flush=True)
        raise SystemExit(130)
    model.eval()
    validation_loss = 0.0
    with torch.no_grad():
        for batch in DataLoader(validation, batch_size=args.batch_size, num_workers=0):
            batch = {key: value.to(args.device) for key, value in batch.items()}
            validation_loss += float(loss(predict(model, batch), batch)) * len(batch["rgb"])
    weights = args.output / "experimental.pt"
    torch.save(model.cpu().state_dict(), weights)
    card = {"architecture": model.architecture, "status": "experimental", "qualified": False,
            "licence": "PRIVATE-PERSONAL" if args.personal else "MIT",
            "scope": "personal" if args.personal else "general", "public_release_allowed": not args.personal,
            "held_out_policy": "independent takes; same personal context" if args.personal else "independent subjects, scenes and takes",
            "pretrained_weights": None, "seed": args.seed, "torch": str(torch.__version__),
            "device": args.device, "steps": completed, "parameters": sum(p.numel() for p in model.parameters()),
            "manifest_sha256": digest(args.manifest), "weights_sha256": digest(weights), "recipe": recipe,
            "reviewed_task_counts": labelled, "resumed_checkpoint_sha256": resumed,
            "first_training_loss": first, "last_training_loss": last,
            "validation_loss": validation_loss / len(validation), "real_camera_acceptance": False,
            "synthetic_only": all(row.get("synthetic", False) for row in dataset.rows + validation.rows)}
    (args.output / "model-card.json").write_text(json.dumps(card, indent=2) + "\n")
    print(json.dumps(card), flush=True)


if __name__ == "__main__":
    main()
