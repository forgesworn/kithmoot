"""Exercise the actual remote transaction against disposable local releases."""
import contextlib
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("phone_access", Path(__file__).with_name("phone-access.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class VisionPin(unittest.TestCase):
    def test_only_the_exact_component_pin_and_repository_can_be_published(self):
        pin = "a" * 40
        entry = f"160000 commit {pin}\tvision\n"
        manifest = {"vision_revision": pin, "vision_repository": "https://github.com/forgesworn/kithmoot-vision"}
        self.assertEqual(publisher.checked_vision_pin(manifest, entry), pin)
        for changed in ({}, {**manifest, "vision_revision": "b" * 40},
                        {**manifest, "vision_repository": "https://example.invalid/other"}):
            with self.assertRaises(ValueError): publisher.checked_vision_pin(changed, entry)
        for changed_entry in ("", f"040000 tree {pin}\tvision", f"160000 commit {pin}\tother"):
            with self.assertRaises(ValueError): publisher.checked_vision_pin(manifest, changed_entry)


class Publication(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kithmoot-phone-transaction-")
        self.addCleanup(self.temporary.cleanup)
        self.root = (Path(self.temporary.name) / "kithmoot").resolve()
        self.original = self.root / "releases/original"
        (self.original / "j").mkdir(parents=True)
        for name, content in {"index.html": "old homepage", "style.css": "old style", "j/app.js": "released calls", "android-release.json": "signed APK manifest"}.items():
            (self.original / name).write_text(content)
        (self.original / "latest.json").symlink_to("android-release.json")
        (self.root / "current").symlink_to(self.original)
        self.config = Path(self.temporary.name) / "Caddyfile"
        self.config.write_text("previous vhost")
        self.program = publisher.REMOTE.replace("Path('/var/www/kithmoot')", "Path(" + repr(str(self.root)) + ")")
        self.program = self.program.replace("Path('/etc/caddy/conf.d/kithmoot.forgesworn.dev.Caddyfile')", "Path(" + repr(str(self.config)) + ")")
        self.release_name = "20261019T000000Z"
        self.release = self.root / "vision-lab/releases" / self.release_name
        self.site_release = self.root / "releases" / self.release_name
        self.files = {"Caddyfile": b"camera lab vhost", "site/index.html": b"new join form", "site/style.css": b"new form style", "lab/index.html": b"experimental lab"}
        self.params = {"release": self.release_name, "revision": "a" * 40, "site": True,
                       "before": {"Caddyfile": self.sha(self.config), **{name: self.sha(self.original / name) for name in ("index.html", "style.css")}},
                       "uploaded": {name: hashlib.sha256(content).hexdigest() for name, content in self.files.items()}}
        self.fail_validation = False
        self.separate_staging_volume = False

    @staticmethod
    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def command(self, args, **kwargs):
        if args[:2] == ["cp", "-al"]:
            shutil.copytree(args[2], args[3], copy_function=os.link, dirs_exist_ok=True, symlinks=True)
        elif args[:4] == ["sudo", "-n", "install", "-m"]:
            shutil.copyfile(args[-2], args[-1])
        elif args[:4] == ["sudo", "-n", "caddy", "validate"]:
            if self.fail_validation:
                self.fail_validation = False
                raise subprocess.CalledProcessError(1, args)
        elif args[:4] != ["sudo", "-n", "systemctl", "reload"]:
            raise AssertionError("Unexpected external command: " + repr(args))
        return subprocess.CompletedProcess(args, 0)

    def phase(self, name):
        output = io.StringIO()
        replace = Path.replace
        def same_volume_replace(path, target):
            if self.separate_staging_volume and path.parent == self.release / 'site':
                raise OSError(errno.EXDEV, 'Cross-device link')
            return replace(path, target)
        with patch("subprocess.run", self.command), patch.object(Path, 'replace', same_volume_replace), contextlib.redirect_stdout(output):
            exec(self.program, {"params": {**self.params, "phase": name}})
        return json.loads(output.getvalue())

    def stage(self):
        self.phase("prepare")
        for name, content in self.files.items():
            path = self.release / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)

    def test_publish_keeps_call_bytes_signed_metadata_and_previous_release(self):
        self.stage(); self.phase("activate")
        result = self.phase("verify")
        self.assertEqual(result["preserved_before"], result["preserved_after"])
        self.assertTrue(result["existing_app_and_downloads_unchanged"])
        self.assertEqual((self.root / "current/index.html").read_text(), "new join form")
        self.assertEqual((self.root / "current/j/app.js").read_text(), "released calls")
        self.assertEqual((self.original / "index.html").read_text(), "old homepage")
        self.assertEqual((self.original / "style.css").read_text(), "old style")
        self.assertTrue((self.root / "current/latest.json").is_symlink())

    def test_failed_caddy_validation_restores_links_config_and_discards_own_release(self):
        self.stage(); self.fail_validation = True
        with self.assertRaises(subprocess.CalledProcessError): self.phase("activate")
        self.assertEqual((self.root / "current").resolve(), self.original)
        self.assertEqual(self.config.read_text(), "previous vhost")
        self.assertFalse((self.root / "vision-lab/current").is_symlink())
        self.assertFalse(self.release.exists()); self.assertFalse(self.site_release.exists())
        self.assertEqual((self.original / "index.html").read_text(), "old homepage")

    def test_rollback_preserves_a_later_publishers_site_and_vhost(self):
        self.stage(); self.phase("activate")
        later = self.root / "releases/later"; later.mkdir()
        (later / "user-work").write_text("keep")
        (self.root / "current").unlink(); (self.root / "current").symlink_to(later)
        self.config.write_text("later publisher's vhost")
        self.phase("rollback")
        self.assertEqual((self.root / "current").resolve(), later)
        self.assertEqual((later / "user-work").read_text(), "keep")
        self.assertEqual(self.config.read_text(), "later publisher's vhost")
        self.assertFalse(self.release.exists()); self.assertFalse(self.site_release.exists())

    def test_changed_live_vhost_is_refused_before_staging(self):
        self.config.write_text("somebody else's change")
        with self.assertRaisesRegex(RuntimeError, "differs"): self.phase("prepare")
        self.assertFalse((self.root / "vision-lab").exists())
        self.assertEqual(self.config.read_text(), "somebody else's change")

    def test_relocated_releases_publish_with_staging_on_another_volume(self):
        bulk = Path(self.temporary.name).resolve() / 'bulk'
        bulk.mkdir()
        (self.root / 'releases').rename(bulk / 'releases')
        (self.root / 'releases').symlink_to(bulk / 'releases', target_is_directory=True)
        self.separate_staging_volume = True
        self.stage(); self.phase('activate')
        result = self.phase('verify')
        self.assertEqual((self.root / 'current').resolve(), bulk / 'releases' / self.release_name)
        self.assertTrue(result['existing_app_and_downloads_unchanged'])
        self.assertEqual((self.root / 'current/index.html').read_text(), 'new join form')
        self.assertEqual((self.original / 'index.html').read_text(), 'old homepage')

    def test_existing_site_release_is_preserved_when_activation_is_refused(self):
        self.stage()
        self.site_release.mkdir()
        work = self.site_release / 'other-publisher-work'
        work.write_text('keep this staged release')
        with self.assertRaisesRegex(RuntimeError, 'already exists'): self.phase('activate')
        self.assertEqual(work.read_text(), 'keep this staged release')
        self.assertEqual((self.root / 'current').resolve(), self.original)
        self.assertFalse(self.release.exists())


if __name__ == "__main__":
    unittest.main()
