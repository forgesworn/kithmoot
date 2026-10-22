import importlib.util
from pathlib import Path
import json
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_relay", Path(__file__).with_name("prepare.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrepareRelayTest(unittest.TestCase):
    def test_separate_accounts_private_files_and_no_overwrite(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-relay-prepare-test-") as root:
            output = Path(root) / "private"
            module.prepare(output, "relay.example", "8.8.8.8")
            you = json.loads((output / "you.json").read_text())
            friend = json.loads((output / "friend.json").read_text())
            self.assertNotEqual(you["credential"], friend["credential"])
            config = (output / "turnserver.conf").read_text()
            self.assertIn(f'user=you:{you["credential"]}', config)
            self.assertIn("lt-cred-mech\n", config)
            self.assertNotIn("no-auth", config)
            self.assertNotIn("allow-loopback-peers", config)
            self.assertIn("no-loopback-peers", config)
            self.assertIn("no-stdout-log", config)
            for path in output.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
            with self.assertRaises(FileExistsError):
                module.prepare(output, "relay.example", "8.8.8.8")
            self.assertEqual(json.loads((output / "you.json").read_text()), you)

    def test_bad_inputs_never_create_files(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-relay-prepare-test-") as root:
            output = Path(root) / "private"
            for host, address in [("relay.example\nno-auth", "8.8.8.8"), ("relay.example", "127.0.0.1"), ("relay.example", "203.0.113.10")]:
                with self.assertRaises(ValueError):
                    module.prepare(output, host, address)
                self.assertFalse(output.exists())

    def test_refuses_credentials_inside_the_checkout(self):
        with self.assertRaisesRegex(ValueError, "outside the repository"):
            module.prepare(Path(__file__).resolve().parents[2] / "private-relay-should-not-exist", "relay.example", "8.8.8.8")


if __name__ == "__main__":
    unittest.main()
