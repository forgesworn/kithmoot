import base64
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import torch
from PIL import Image

from kithmoot_vision.data import Frames, read_manifest
from kithmoot_vision.evaluate import evaluate_mode
from kithmoot_vision.learning import loss, predict
from kithmoot_vision.model import MobileCameraVision
from kithmoot_vision.synthetic import generate
from kithmoot_vision.workshop import FORMAT, import_workshop


def png(colour, mode="RGB"):
    buffer = io.BytesIO()
    Image.new(mode, (64, 48), colour).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def reviewed_bundle():
    sources, samples = [], []
    for index, split in enumerate(("train", "validation", "test")):
        source = {"id": split, "status": "approved", "licence": "PROJECT-OWNED", "url": "https://example.invalid/owned-fixture",
                  "sha256": str(index) * 64, "reviewer": "Automated test, original synthetic fixtures only",
                  "reviewed_at": "2026-10-19T12:00:00Z", "terms": "Original test images; MIT training permitted.",
                  "permission_basis": "No real subjects. These fixtures cannot qualify a camera model.",
                  "subjects": [split + "-synthetic"], "scene": split, "sequence": split, "split": split,
                  "synthetic": True, "training": True, "commercial": True, "mit_weights": True, "subject_permission": True}
        sources.append(source)
        samples.append({"id": split + "-frame", "source": split, "time": index,
                        "labels": {"faces": True, "foreground": True}, "rgb": png((index * 60, 80, 160)),
                        "alpha": png(255, "L"), "faces": [[.25, .25, .25, .25]],
                        "faces_complete": True, "foreground_reviewed": True})
    return {"format": FORMAT, "scope": "general", "public_model_permission": True, "sources": sources, "samples": samples}


class WorkshopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_reviewed_import_retains_evidence_and_rejects_pending_or_private_sources(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-workshop-test-") as temporary:
            root = Path(temporary)
            path = root / "bundle.json"
            original = reviewed_bundle()
            path.write_text(json.dumps(original))
            manifest = import_workshop([path], root / "accepted")
            rows = read_manifest(manifest)
            self.assertEqual(len(rows), 3)
            evidence = json.loads((manifest.parent / rows[0]["rights"]["evidence"]).read_text())
            self.assertEqual(evidence["sha256"], original["sources"][0]["sha256"])
            self.assertEqual(evidence["reviewer"], original["sources"][0]["reviewer"])
            for index, change in enumerate((lambda b: b.update(scope="personal"),
                                             lambda b: b.update(public_model_permission=False),
                                             lambda b: b["sources"][0].update(status="pending"),
                                             lambda b: b["sources"][0].update(licence="CC-BY-NC-4.0"),
                                             lambda b: b["sources"][0].update(mit_weights=False),
                                             lambda b: b["sources"][0].update(permission_basis=""),
                                             lambda b: b["samples"][0].update(faces_complete=False),
                                             lambda b: b["samples"][0].update(foreground_reviewed=False))):
                altered = copy.deepcopy(original); change(altered); path.write_text(json.dumps(altered))
                with self.assertRaises(ValueError): import_workshop([path], root / f"refused-{index}")
                self.assertFalse((root / f"refused-{index}").exists())

    def test_same_source_or_person_cannot_cross_splits_even_with_different_frame_ids(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-workshop-test-") as temporary:
            root = Path(temporary)
            for index, field in enumerate(("sha256", "subjects", "scene", "sequence")):
                bundle = reviewed_bundle()
                bundle["sources"][-1][field] = bundle["sources"][0][field]
                path = root / f"source-{index}.json"; path.write_text(json.dumps(bundle))
                with self.assertRaisesRegex(ValueError, "leak"):
                    import_workshop([path], root / f"refused-{index}")
                self.assertFalse((root / f"refused-{index}").exists())

    def test_letterboxing_keeps_images_labels_and_face_boxes_in_the_same_coordinates(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-workshop-test-") as temporary:
            root = Path(temporary)
            path = root / "bundle.json"; path.write_text(json.dumps(reviewed_bundle()))
            manifest = import_workshop([path], root / "data")
            dataset = Frames(manifest, "train", size=(32, 32))
            batch = dataset[0]
            self.assertEqual(dataset._geometry(dataset.rows[0]), ((64, 48), 32, 24, 0, 4))
            self.assertEqual(float(batch["alpha"].sum()), 32 * 24)
            self.assertEqual(float(batch["alpha"][:, :4].sum()), 0)
            self.assertEqual(float(batch["rgb"][:, :4].sum()), 0)
            self.assertAlmostEqual(float(batch["face_boxes"][1, 3, 3]), .25)
            self.assertAlmostEqual(float(batch["face_boxes"][3, 3, 3]), .1875)

    def test_partial_supervision_skips_unknown_labels_and_inactive_adamw_heads(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-workshop-test-") as temporary:
            manifest = generate(Path(temporary) / "data", count=4)
            rows = read_manifest(manifest)
            for index, row in enumerate(rows):
                faces = index % 2 == 0
                row["labels"] = {"faces": faces, "foreground": not faces}
                if faces:
                    for name in ("alpha", "reference", "held_objects"): row.pop(name)
                else:
                    row["faces"] = []; row["faces_complete"] = False
            manifest.write_text("".join(json.dumps(row) + "\n" for row in rows))
            dataset = Frames(manifest, "train")
            model = MobileCameraVision()
            optimiser = torch.optim.AdamW(model.parameters(), lr=.01, weight_decay=.2)
            for index, inactive in ((0, "matte.0.weight"), (1, "face_heatmap.weight")):
                batch = {key: value[None] for key, value in dataset[index].items()}
                before = model.state_dict()[inactive].clone()
                optimiser.zero_grad(set_to_none=True)
                loss(predict(model, batch), batch).backward()
                self.assertIsNone(dict(model.named_parameters())[inactive].grad)
                optimiser.step()
                self.assertTrue(torch.equal(before, model.state_dict()[inactive]))
            report = evaluate_mode(model.eval(), Frames(manifest, "test"), use_reference=False)
            self.assertEqual(report["face_labelled_frames"], 2)
            self.assertEqual(report["foreground_labelled_frames"], 2)

    def test_resumed_cpu_training_matches_uninterrupted_weights_and_rejects_changed_recipe(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-workshop-test-") as temporary:
            root = Path(temporary)
            manifest = generate(root / "data", count=4)
            def train(name, steps, *extra, succeeds=True):
                result = subprocess.run([sys.executable, "-m", "kithmoot_vision.train", str(manifest), str(root / name),
                                         "--steps", str(steps), "--batch-size", "3", "--checkpoint-every", "2", *extra],
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode == 0, succeeds, result.stderr + result.stdout)
                return root / name
            direct = train("direct", 7)
            first = train("first", 3)
            resumed = train("resumed", 7, "--resume", str(first / "checkpoint.pt"))
            a = torch.load(direct / "experimental.pt", weights_only=True)
            b = torch.load(resumed / "experimental.pt", weights_only=True)
            self.assertTrue(all(torch.equal(a[key], b[key]) for key in a))
            card = json.loads((resumed / "model-card.json").read_text())
            self.assertTrue(card["resumed_checkpoint_sha256"])
            self.assertFalse(card["qualified"])
            train("changed-seed", 8, "--resume", str(first / "checkpoint.pt"), "--seed", "19", succeeds=False)
            self.assertFalse((root / "changed-seed").exists())


if __name__ == "__main__":
    unittest.main()
