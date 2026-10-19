#!/usr/bin/env python3
"""Publish the read-only Camera Lab and optional homepage without rebuilding calls.

DEPLOY_HOST is required; DEPLOY_KEY optionally selects an SSH key. The exact
previous source revision guards the live vhost and homepage against overwrites.
Only original drawing weights can be published. Personal media stays local.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
import urllib.error
import urllib.request

SOURCE = Path(__file__).resolve().parent.parent
BASE_URL = "https://kithmoot.forgesworn.dev/camera-lab/"
SITE_FILES = ("index.html", "style.css")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_vision_pin(manifest, tree_entry):
    match = re.fullmatch(r"160000 commit ([0-9a-f]{40})\tvision", tree_entry.strip())
    if not match or manifest.get("vision_revision") != match.group(1):
        raise ValueError("Rebuild the preview with KithMoot's pinned vision dependency")
    if manifest.get("vision_repository") != "https://github.com/forgesworn/kithmoot-vision":
        raise ValueError("Preview must record the independent vision repository")
    return match.group(1)


REMOTE = r'''
import hashlib, json, os, shutil, subprocess
from pathlib import Path
root = Path('/var/www/kithmoot').resolve()
lab = root / 'vision-lab'
release = lab / 'releases' / params['release']
site_release = root / 'releases' / params['release']
config = Path('/etc/caddy/conf.d/kithmoot.forgesworn.dev.Caddyfile')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def link(path):
    if path.is_symlink(): return os.readlink(path)
    if path.exists(): raise RuntimeError('Refusing a non-symlink current path')
    return None
def flip(path, target):
    temporary = path.parent / ('.phone-' + params['release'])
    if temporary.exists() or temporary.is_symlink(): raise RuntimeError('Activation path already exists')
    if target is None:
        path.unlink(missing_ok=True)
    else:
        temporary.symlink_to(target); temporary.replace(path)
def preserved_digest(directory):
    result = hashlib.sha256()
    for path in sorted(directory.rglob('*')):
        name = path.relative_to(directory).as_posix()
        if name in ('index.html', 'style.css'): continue
        if path.is_symlink(): value = 'link:' + os.readlink(path)
        elif path.is_file(): value = sha(path)
        else: continue
        result.update((name + '\0' + value + '\n').encode())
    return result.hexdigest()
def reload_config(source):
    subprocess.run(['sudo', '-n', 'install', '-m', '0644', str(source), str(config)], check=True, capture_output=True)
    subprocess.run(['sudo', '-n', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], check=True, capture_output=True)
    subprocess.run(['sudo', '-n', 'systemctl', 'reload', 'caddy'], check=True, capture_output=True)
def rollback(state):
    if link(root / 'current') == str(site_release): flip(root / 'current', state['previous_site'])
    if link(lab / 'current') == str(release / 'lab'): flip(lab / 'current', state['previous_lab'])
    backup = release / 'previous.Caddyfile'
    if params['before']['Caddyfile'] != params['uploaded']['Caddyfile'] and config.exists() and sha(config) == params['uploaded']['Caddyfile'] and backup.exists() and sha(backup) == params['before']['Caddyfile']:
        reload_config(backup)
    if state.get('created_site') and site_release.exists() and link(root / 'current') != str(site_release): shutil.rmtree(site_release)
    if release.exists() and link(lab / 'current') != str(release / 'lab'): shutil.rmtree(release)
    for path, created in ((lab / 'releases', state.get('created_releases')), (lab, state.get('created_lab'))):
        if created:
            try: path.rmdir()
            except OSError: pass

phase = params['phase']
if phase == 'prepare':
    if not (root / 'current').is_symlink(): raise RuntimeError('Existing KithMoot deployment is required')
    if sha(config) != params['before']['Caddyfile']: raise RuntimeError('Live vhost differs from the supplied base revision')
    current = (root / 'current').resolve(strict=True)
    if not current.is_relative_to((root / 'releases').resolve()): raise RuntimeError('Unexpected site release location')
    if params['site']:
        for name in ('index.html', 'style.css'):
            if sha(current / name) != params['before'][name]: raise RuntimeError('Live homepage changed: ' + name)
    state = {'previous_site': link(root / 'current'), 'previous_lab': link(lab / 'current'),
             'created_lab': not lab.exists(), 'created_releases': not (lab / 'releases').exists(), 'created_site': False,
             'preserved_before': preserved_digest(current), 'revision': params['revision'],
             'vision_revision': params.get('vision_revision'), 'release': params['release']}
    release.mkdir(parents=True, exist_ok=False)
    try:
        (release / 'state.json').write_text(json.dumps(state))
        shutil.copy2(config, release / 'previous.Caddyfile')
        if sha(release / 'previous.Caddyfile') != params['before']['Caddyfile']: raise RuntimeError('Vhost changed during preparation')
    except BaseException:
        rollback(state)
        raise
    print(json.dumps(state))
else:
    state = json.loads((release / 'state.json').read_text())
    if phase == 'activate':
        try:
            if link(root / 'current') != state['previous_site'] or link(lab / 'current') != state['previous_lab']:
                raise RuntimeError('Another deployment moved a current link')
            if sha(config) != params['before']['Caddyfile']: raise RuntimeError('Vhost changed during staging')
            for name, expected in params['uploaded'].items():
                if sha(release / name) != expected: raise RuntimeError('Uploaded checksum mismatch: ' + name)
            if params['site']:
                if site_release.exists(): raise RuntimeError('Site release already exists')
                site_release.mkdir()
                state['created_site'] = True
                (release / 'state.json').write_text(json.dumps(state))
                subprocess.run(['cp', '-al', str((root / 'current').resolve()) + '/.', str(site_release)], check=True)
                # The staged lab and bulk website may be on different disks.
                # Copy into the destination before atomically replacing a link.
                for name in ('index.html', 'style.css'):
                    incoming = site_release / ('.phone-' + name)
                    shutil.copyfile(release / 'site' / name, incoming)
                    incoming.chmod(0o644)
                    incoming.replace(site_release / name)
            flip(lab / 'current', str(release / 'lab'))
            if params['before']['Caddyfile'] != params['uploaded']['Caddyfile']: reload_config(release / 'Caddyfile')
            if params['site']:
                if link(root / 'current') != state['previous_site']: raise RuntimeError('Another site deployment won the race')
                flip(root / 'current', str(site_release))
            print(json.dumps({'activated': True}))
        except BaseException:
            rollback(state)
            raise
    elif phase == 'verify':
        after = preserved_digest((root / 'current').resolve(strict=True))
        if after != state['preserved_before']: raise RuntimeError('Existing app or download assets changed')
        state['preserved_after'] = after
        state['existing_app_and_downloads_unchanged'] = True
        (release / 'state.json').write_text(json.dumps(state, indent=2) + '\n')
        with (root / 'phone-access-revisions.jsonl').open('a') as log: log.write(json.dumps(state) + '\n')
        print(json.dumps(state))
    elif phase == 'rollback':
        rollback(state); print(json.dumps({'rolled_back': True}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lab", type=Path, required=True)
    parser.add_argument("--base-revision", required=True)
    parser.add_argument("--site", action="store_true", help="Also replace only the homepage HTML and stylesheet")
    parser.add_argument("--check", action="store_true", help="Validate locally without connecting to the server")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.base_revision):
        parser.error("Use the exact 40-character base revision")
    manifest = json.loads((args.lab / "lab-manifest.json").read_text())
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
    if manifest.get("format") != "kithmoot-camera-lab-static-v1" or manifest.get("revision") != revision or manifest.get("source_dirty") is not False:
        parser.error("Rebuild the lab from the current committed source")
    tree_entry = subprocess.check_output(["git", "ls-tree", "HEAD", "--", "vision"], cwd=SOURCE, text=True)
    try:
        vision_revision = checked_vision_pin(manifest, tree_entry)
    except ValueError as error:
        parser.error(str(error))
    if manifest.get("model_scope") != "original-drawings-only" or any(manifest.get(name) is not False for name in ("qualified", "camera_frames_uploaded", "audio_recorded")):
        parser.error("Hosted preview metadata must retain its experimental and local-only status")
    if subprocess.run(["git", "diff", "--quiet", "HEAD", "--"], cwd=SOURCE).returncode:
        parser.error("Commit tracked changes before publishing")
    expected = {**manifest["files"], "lab-manifest.json": digest((args.lab / "lab-manifest.json").read_bytes())}
    found = {path.relative_to(args.lab).as_posix() for path in args.lab.rglob("*") if path.is_file()}
    if found != set(expected) or any(path.is_symlink() for path in args.lab.rglob("*")):
        parser.error("Preview has unlisted files or symbolic links")
    for name, value in expected.items():
        if not re.fullmatch(r"[A-Za-z0-9_./-]+", name) or ".." in Path(name).parts or Path(name).is_absolute():
            parser.error("Unsafe preview filename")
        if digest((args.lab / name).read_bytes()) != value:
            parser.error("Preview checksum mismatch: " + name)
    card = json.loads((args.lab / "default.json").read_text())
    if card.get("scope") != "general" or card.get("synthetic_only") is not True or card.get("public_release_allowed") is not True or card.get("licence") != "MIT" or card.get("qualified") is not False or card.get("pretrained_weights") is not None:
        parser.error("Only original drawing weights can be published; personal models stay local")
    if card.get("portable_weights_sha256") != manifest.get("model_sha256") or card.get("portable_weights_sha256") != digest((args.lab / "default.kvm").read_bytes()):
        parser.error("Drawing model and export card differ")
    if args.check:
        print(json.dumps({"checked": True, "revision": revision, "vision_revision": vision_revision, "files": len(expected), "personal_models_published": False}))
        return
    subprocess.run(["git", "merge-base", "--is-ancestor", revision, "origin/main"], cwd=SOURCE, check=True)
    host = os.environ.get("DEPLOY_HOST", "")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]*", host): parser.error("Set DEPLOY_HOST to the intended SSH host")
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"]
    if os.environ.get("DEPLOY_KEY"): ssh += ["-i", os.environ["DEPLOY_KEY"], "-o", "IdentitiesOnly=yes"]
    release = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-phone-" + revision[:8]
    before = {"Caddyfile": digest(subprocess.check_output(["git", "show", args.base_revision + ":deploy/Caddyfile.kithmoot"], cwd=SOURCE))}
    if args.site:
        before.update({name: digest(subprocess.check_output(["git", "show", args.base_revision + ":site/" + name], cwd=SOURCE)) for name in SITE_FILES})
    params = {"release": release, "revision": revision, "vision_revision": vision_revision, "site": args.site, "before": before}
    if args.receipt and (args.receipt.exists() or args.receipt.is_symlink()): parser.error("Refusing to overwrite a receipt")
    if args.receipt and not args.receipt.parent.is_dir(): parser.error("Receipt directory must already exist")

    def remote(phase):
        code = "params = " + repr({**params, "phase": phase}) + "\n" + REMOTE
        result = subprocess.run([*ssh, host, "python3 -"], input=code, text=True, stdout=subprocess.PIPE, check=True)
        return json.loads(result.stdout)

    def fetch(url, method="GET"):
        request = urllib.request.Request(url, method=method, headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache", "Accept-Encoding": "identity"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read(), response.headers

    with tempfile.TemporaryDirectory(prefix="kithmoot-phone-publish-") as temporary:
        staging = Path(temporary)
        for name in expected:
            destination = staging / "lab" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(args.lab / name, destination)
        shutil.copyfile(SOURCE / "deploy/Caddyfile.kithmoot", staging / "Caddyfile")
        if args.site:
            (staging / "site").mkdir()
            for name in SITE_FILES: shutil.copyfile(SOURCE / "site" / name, staging / "site" / name)
        for directory, _, files in os.walk(staging):
            Path(directory).chmod(0o755)
            for name in files: (Path(directory) / name).chmod(0o644)
        params["uploaded"] = {path.relative_to(staging).as_posix(): digest(path.read_bytes()) for path in staging.rglob("*") if path.is_file()}
        remote("prepare")
        active = False
        try:
            subprocess.run(["rsync", "-az", "-e", shlex.join(ssh), str(staging) + "/", f"{host}:/var/www/kithmoot/vision-lab/releases/{release}/"], check=True)
            remote("activate"); active = True
            nonce = "?verify=" + revision[:12]
            for name, value in expected.items():
                content, _ = fetch(BASE_URL + name + nonce)
                if digest(content) != value: raise RuntimeError("Public preview checksum mismatch: " + name)
            _, headers = fetch(BASE_URL + nonce)
            for name, value in manifest["headers"].items():
                if headers.get(name) != value: raise RuntimeError("Public preview header mismatch: " + name)
            try: fetch(BASE_URL, method="POST")
            except urllib.error.HTTPError as error:
                if error.code != 405: raise
            else: raise RuntimeError("Hosted preview must reject uploads")
            if args.site:
                homepage_headers = None
                for name in SITE_FILES:
                    content, site_headers = fetch("https://kithmoot.app/" + ("" if name == "index.html" else name) + nonce)
                    if digest(content) != params["uploaded"]["site/" + name]: raise RuntimeError("Public homepage checksum mismatch: " + name)
                    if name == "index.html": homepage_headers = site_headers
                if "form-action https://kithmoot.forgesworn.dev/j/" not in homepage_headers.get("Content-Security-Policy", ""):
                    raise RuntimeError("Homepage policy must allow its native join form")
                if not all(value in homepage_headers.get("Permissions-Policy", "") for value in ("camera=()", "microphone=()")):
                    raise RuntimeError("The marketing page must leave device access to the app and lab")
            state = remote("verify")
        except BaseException:
            # Activation rolls back its own failures. Guard every later rollback
            # against another publisher moving the shared app/current links.
            if active or not subprocess.run([*ssh, host, "test -d /var/www/kithmoot/vision-lab/releases/" + release]).returncode:
                try: remote("rollback")
                except subprocess.CalledProcessError: pass
            raise
    receipt = {"revision": revision, "vision_revision": vision_revision, "base_revision": args.base_revision, "published_at": datetime.now(timezone.utc).isoformat(),
               "lab_url": BASE_URL, "homepage_updated": args.site, "qualified": False,
               "model_sha256": card["portable_weights_sha256"], "verified_public_files": len(expected),
               "uploads_rejected": True, "camera_frames_uploaded": False, "audio_recorded": False, **state}
    if args.receipt:
        with args.receipt.open("x") as output: output.write(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
