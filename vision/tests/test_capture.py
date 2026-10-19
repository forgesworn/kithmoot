import base64
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from kithmoot_vision.capture import import_captures
from kithmoot_vision.data import Frames, read_manifest


def png(colour, mode="RGB", size=(32, 24)):
    buffer = io.BytesIO()
    Image.new(mode, size, colour).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def bundle():
    return {"format": "kithmoot-vision-captures-v1", "scope": "personal", "samples": [
        {"id": split, "sequence": "take-" + split, "split": split, "synthetic": False,
         "rgb": png((20 + index * 30, 100, 150)), "alpha": png(255, "L"),
         "reference": png((20, 100, 150)), "held_objects": png(255, "L"),
         "faces": [[0.2, 0.2, 0.3, 0.3], [0.6, 0.4, 0.2, 0.3]],
         "facesComplete": True, "foregroundReviewed": True, "permissionReviewed": True}
        for index, split in enumerate(("train", "validation", "test"))]}


class CaptureTests(unittest.TestCase):
    def test_personal_roundtrip_reuses_room_and_people_but_cannot_enter_general_training(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "capture.json"
            source.write_text(json.dumps(bundle()))
            manifest = import_captures([source], root / "personal")
            rows = read_manifest(manifest, personal=True)
            self.assertEqual(len(rows), 3)
            self.assertFalse(rows[0]["rights"]["commercial"])
            self.assertFalse(rows[0]["rights"]["mit_weights"])
            sample = Frames(manifest, "train", size=(32, 24), personal=True)[0]
            self.assertEqual(int(sample["face_heat"].sum()), 2)
            self.assertEqual(float(sample["alpha"].mean()), 1)
            with self.assertRaisesRegex(ValueError, "Personal"):
                Frames(manifest, "train")
            with self.assertRaisesRegex(ValueError, "already exists"):
                import_captures([source], root / "personal")

    def test_review_take_and_pixel_leakage_and_object_erasure_are_refused(self):
        mutations = [
            (lambda b: b["samples"][0].update(permissionReviewed=False), "Review"),
            (lambda b: b["samples"][0].update(facesComplete=False), "Review"),
            (lambda b: b["samples"][1].update(sequence=b["samples"][0]["sequence"]), "sequence leaks"),
            (lambda b: b["samples"][1].update(rgb=b["samples"][0]["rgb"]), "Identical pictures"),
            (lambda b: b["samples"][0].update(alpha=png(0, "L")), "Held objects"),
            (lambda b: b["samples"][0].update(reference=png(0, "L", (16, 16))), "must match"),
            (lambda b: b["samples"][0].update(faces=[[float("nan"), 0, 1, 1]]), "face box"),
            (lambda b: b["samples"].pop(), "independent"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for mutate, message in mutations:
                with self.subTest(message=message):
                    data = copy.deepcopy(bundle()); mutate(data)
                    path = root / "bad.json"; path.write_text(json.dumps(data))
                    with self.assertRaisesRegex(ValueError, message):
                        import_captures([path], root / "rejected")
                    self.assertFalse((root / "rejected").exists())

    def test_personal_permission_cannot_be_upgraded_by_a_manifest_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "capture.json"
            source.write_text(json.dumps(bundle()))
            manifest = import_captures([source], root / "personal")
            rows = read_manifest(manifest, personal=True)
            rows[0]["rights"]["mit_weights"] = True
            manifest.write_text("".join(json.dumps(row) + "\n" for row in rows))
            with self.assertRaisesRegex(ValueError, "public model-release"):
                read_manifest(manifest, personal=True)


if __name__ == "__main__":
    unittest.main()
