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
            self.assertIn("listening-ip=8.8.8.8\n", config)
            self.assertIn("relay-ip=8.8.8.8\n", config)
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

    def test_alternate_listener_preserves_an_existing_stun_service(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-relay-prepare-test-") as root:
            output = Path(root) / "private"
            module.prepare(output, "relay.example", "8.8.8.8", port=3479, relay_min=49500, relay_max=49531)
            self.assertIn("listening-port=3479\n", (output / "turnserver.conf").read_text())
            self.assertIn("min-port=49500\nmax-port=49531\n", (output / "turnserver.conf").read_text())
            self.assertEqual(json.loads((output / "friend.json").read_text())["urls"],
                             ["turn:relay.example:3479", "turn:relay.example:3479?transport=tcp"])
            for port in [0, 65536, 49180, 49211]:
                with self.assertRaises(ValueError):
                    module.prepare(Path(root) / "invalid", "relay.example", "8.8.8.8", port=port)
                self.assertFalse((Path(root) / "invalid").exists())
            for low, high in [(0, 10), (65530, 65536), (49531, 49500), (1, 5000)]:
                with self.assertRaises(ValueError):
                    module.prepare(Path(root) / "invalid-range", "relay.example", "8.8.8.8", relay_min=low, relay_max=high)
                self.assertFalse((Path(root) / "invalid-range").exists())

    def test_refuses_credentials_inside_the_checkout(self):
        with self.assertRaisesRegex(ValueError, "outside the repository"):
            module.prepare(Path(__file__).resolve().parents[2] / "private-relay-should-not-exist", "relay.example", "8.8.8.8")

    def test_udp_only_listener_has_no_tcp_alternative(self):
        with tempfile.TemporaryDirectory(prefix="kithmoot-relay-prepare-test-") as root:
            output = Path(root) / "private"
            module.prepare(output, "relay.example", "8.8.8.8", port=49300,
                           relay_min=49301, relay_max=49332, udp_only=True)
            self.assertIn("no-tcp\n", (output / "turnserver.conf").read_text())
            self.assertEqual(json.loads((output / "you.json").read_text())["urls"],
                             ["turn:relay.example:49300?transport=udp"])


if __name__ == "__main__":
    unittest.main()
