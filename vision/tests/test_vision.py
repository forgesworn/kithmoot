import copy
import json
import tempfile
import unittest
from pathlib import Path

import torch

from kithmoot_vision.data import Frames, read_manifest
from kithmoot_vision.decode import decode
from kithmoot_vision.learning import adapt_step, loss, predict
from kithmoot_vision.model import CameraVision, MobileCameraVision, MatteAdapter
from kithmoot_vision.synthetic import generate


class VisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_real_backpropagation_updates_face_and_matte_heads(self):
        torch.manual_seed(18)
        model = CameraVision()
        batch = {"rgb": torch.rand(2, 3, 32, 32), "reference": torch.rand(2, 3, 32, 32),
                 "reference_valid": torch.ones(2, 1, 32, 32), "previous_alpha": torch.zeros(2, 1, 32, 32),
                 "alpha": torch.ones(2, 1, 32, 32), "face_heat": torch.zeros(2, 1, 8, 8),
                 "face_boxes": torch.full((2, 4, 8, 8), 0.25)}
        batch["face_heat"][:, :, 3, 4] = 1
        before = {key: value.clone() for key, value in model.state_dict().items()}
        optimiser = torch.optim.Adam(model.parameters(), lr=0.003)
        first = float(loss(predict(model, batch), batch).detach())
        for _ in range(12):
            optimiser.zero_grad()
            objective = loss(predict(model, batch), batch)
            objective.backward()
            optimiser.step()
        self.assertLess(float(objective.detach()), first)
        for head in ("face_heatmap.weight", "face_boxes.weight", "matte.2.weight"):
            self.assertFalse(torch.equal(before[head], model.state_dict()[head]), head)

    def test_reference_and_adapter_cannot_change_face_predictions(self):
        model = CameraVision().eval()
        batch = {"rgb": torch.rand(1, 3, 32, 32), "reference": torch.rand(1, 3, 32, 32),
                 "reference_valid": torch.ones(1, 1, 32, 32), "previous_alpha": torch.zeros(1, 1, 32, 32),
                 "alpha": torch.ones(1, 1, 32, 32)}
        state = copy.deepcopy(model.state_dict())
        face = predict(model, batch)["face_logits"].detach()
        adapter = MatteAdapter()
        optimiser = torch.optim.Adam(adapter.parameters(), lr=0.02)
        adapt_step(model, adapter, batch, optimiser)
        batch["reference"] *= 0
        batch["reference_valid"] *= 0
        self.assertTrue(torch.equal(face, predict(model, batch)["face_logits"]))
        self.assertTrue(all(torch.equal(state[key], value) for key, value in model.state_dict().items()))
        base = torch.full((1, 1, 32, 32), 0.9)
        adapted = adapter(batch["rgb"], batch["reference"], base)
        self.assertTrue(torch.all((adapted - base).abs() <= 0.100001))
        self.assertGreater(float(adapter.layers[-1].weight.detach().abs().sum()), 0)

    def test_invalid_reference_is_ignored(self):
        model = CameraVision().eval()
        rgb = torch.rand(1, 3, 32, 32)
        zero = torch.zeros(1, 1, 32, 32)
        a = model(rgb, torch.ones_like(rgb), zero, zero)
        b = model(rgb, torch.zeros_like(rgb), zero, zero)
        self.assertTrue(torch.equal(a["alpha_logits"], b["alpha_logits"]))

    def test_mobile_head_is_learned_and_keeps_the_same_spatial_outputs(self):
        model = MobileCameraVision()
        rgb = torch.rand(1, 3, 32, 24)
        reference = torch.zeros_like(rgb)
        zero = torch.zeros(1, 1, 32, 24)
        outputs = model(rgb, reference, zero, zero)
        self.assertEqual(sum(p.numel() for p in model.parameters()), 19_974)
        self.assertEqual(outputs["alpha_logits"].shape, (1, 1, 32, 24))
        self.assertEqual(outputs["face_logits"].shape, (1, 1, 8, 6))
        outputs["alpha_logits"].square().mean().backward()
        for name in ("matte.0.weight", "matte.2.weight", "matte.4.weight", "matte.6.weight", "matte.8.weight"):
            self.assertGreater(float(model.state_dict()[name].abs().sum()), 0)
            self.assertIsNotNone(dict(model.named_parameters())[name].grad)

    def test_decodes_multiple_faces_and_refuses_overflow_or_malformed_results(self):
        logits = torch.full((1, 8, 8), -10.0)
        logits[0, 2, 2] = logits[0, 5, 5] = 10
        boxes = torch.full((4, 8, 8), 0.2)
        result = decode(logits, boxes)
        self.assertTrue(result.usable)
        self.assertEqual(len(result.faces), 2)
        self.assertFalse(decode(logits, boxes, max_faces=1).usable)
        boxes[0, 0, 0] = float("nan")
        self.assertFalse(decode(logits, boxes).usable)
        self.assertFalse(decode(torch.full((1, 8, 8), -10.0), boxes).usable)

    def test_manifests_reject_restricted_data_personal_uploads_and_split_leaks(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-vision-test-") as temporary:
            manifest = generate(Path(temporary) / "data", count=4)
            rows = read_manifest(manifest)
            self.assertGreater(len(Frames(manifest, "train")), 0)
            original = manifest.read_text()
            for mutation, message in ((lambda r: r[0]["rights"].update(licence="CC-BY-NC-4.0"), "licence"),
                                      (lambda r: r[0].update(scope="personal"), "Personal"),
                                      (lambda r: r[-1].update(scene=r[0]["scene"]), "leaks"),
                                      (lambda r: r[0]["rgb"].update(sha256="0" * 64), "checksum"),
                                      (lambda r: r[0].update(faces_complete=False), "visible face")):
                altered = copy.deepcopy(rows)
                mutation(altered)
                manifest.write_text("".join(json.dumps(row) + "\n" for row in altered))
                with self.assertRaisesRegex(ValueError, message):
                    read_manifest(manifest)
                manifest.write_text(original)


if __name__ == "__main__":
    unittest.main()
