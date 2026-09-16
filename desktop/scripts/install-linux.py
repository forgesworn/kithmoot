#!/usr/bin/env python3
"""Install the extracted preview for this user; never alter the profile."""
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

source = Path(__file__).resolve().parent
if sys.platform != 'linux':
    sys.exit('Run this installer on Linux.')
# Check ELF architecture before creating any files.
elf = (source / 'kithmoot').read_bytes()[:20]
expected = {'x86_64': 62, 'aarch64': 183}.get(platform.machine())
if elf[:4] != b'\x7fELF' or int.from_bytes(elf[18:20], 'little') != expected:
    sys.exit('This package does not match your CPU. Download x64 for Intel/AMD or arm64 for ARM.')
home = Path.home()
base = Path(os.environ.get('XDG_DATA_HOME', str(home / '.local/share')))
if not base.is_absolute():
    sys.exit('XDG_DATA_HOME must be an absolute path.')
target = base / 'kithmoot-desktop'
if source == target:
    sys.exit('Already installed here. Open KithMoot from Applications.')
# Refuse replacements while this installed app is running.
for proc in Path('/proc').glob('[0-9]*/exe'):
    try:
        if proc.resolve().is_relative_to(target):
            sys.exit('Please quit KithMoot, then run this installer again.')
    except (OSError, RuntimeError):
        pass
staging = base / 'kithmoot-desktop.new'
backup = base / 'kithmoot-desktop.previous'
if staging.exists() or backup.exists():
    sys.exit(f'An earlier update exists at {staging} or {backup}. Preserve it or remove it before retrying.')
base.mkdir(parents=True, exist_ok=True)
shutil.copytree(source, staging)
try:
    if target.exists(): target.rename(backup)
    staging.rename(target)
except Exception:
    if backup.exists() and not target.exists(): backup.rename(target)
    raise
# Desktop Exec quoting: percent is a field-code escape, even inside quotes.
def quoted(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%') + '"'
applications = base / 'applications'
applications.mkdir(parents=True, exist_ok=True)
entry = applications / 'dev.forgesworn.kithmoot.desktop'
entry.write_text('[Desktop Entry]\nType=Application\nName=KithMoot\nComment=Private rooms, chat and calls\nExec=' + quoted(target / 'kithmoot') + '\nIcon=' + str(target / 'resources/app.asar.unpacked/icon.png') + '\nTerminal=false\nCategories=Network;InstantMessaging;\nStartupWMClass=KithMoot\n')
# Icon outside ASAR is also available to the launcher when the app is closed.
icon = target / 'kithmoot.png'
shutil.copyfile(source / 'kithmoot.png', icon)
entry.write_text(entry.read_text().replace(str(target / 'resources/app.asar.unpacked/icon.png'), str(icon)))
if shutil.which('update-desktop-database'):
    subprocess.run(['update-desktop-database', str(applications)], check=False)
if backup.exists(): shutil.rmtree(backup)
print(f'Installed {target}. Open KithMoot from Applications. Your account data is unchanged.')
