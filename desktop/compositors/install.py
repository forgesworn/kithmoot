#!/usr/bin/env python3
"""Install an opt-in drawing companion. Never enables compositor extensions."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('desktop', choices=['gnome', 'plasma'])
args = parser.parse_args()
source = Path(__file__).resolve().parent
if args.desktop == 'gnome':
    metadata = json.loads((source / 'gnome/metadata.json').read_text())
    destination = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'gnome-shell/extensions' / metadata['uuid']
    destination.mkdir(parents=True, exist_ok=True)
    for name in ['extension.js', 'metadata.json']:
        shutil.copy2(source / 'gnome' / name, destination / name)
    (destination / 'schemas').mkdir(exist_ok=True)
    for schema in (source / 'gnome/schemas').glob('*.xml'):
        shutil.copy2(schema, destination / 'schemas' / schema.name)
    subprocess.run(['glib-compile-schemas', '--strict', str(destination / 'schemas')], check=True)
    print(f'Installed {destination}. Log out and back in, then enable "KithMoot shared-window drawings" in Extensions.')
    print(f'Alternatively, after login: gnome-extensions enable {metadata["uuid"]}')
    print('To remove: disable the extension in Extensions, then remove only that extension directory.')
else:
    # KWin explicitly provides no binary ABI guarantee: build against the
    # recipient's installed KWin SDK, never distribute a mismatched .so.
    destination = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'kithmoot/compositor-build'
    subprocess.run(['cmake', '-S', str(source / 'kwin'), '-B', str(destination), '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_PREFIX=/usr'], check=True)
    subprocess.run(['cmake', '--build', str(destination), '-j2'], check=True)
    print('Built against your installed KWin. Install the effect with your system package permissions:')
    import shlex
    print(f'sudo cmake --install {shlex.quote(str(destination))}')
    print('Then enable "KithMoot shared-window drawings" in System Settings > Window Management > Desktop Effects.')
    print('Rebuild this effect after a KWin upgrade. To remove, disable it there and remove the path in install_manifest.txt.')
print('While sharing: focus the shared window and press Super+Shift+D; for a display use Super+Shift+S.')
print('Escape returns to ordinary app use. Super+Shift+C clears drawings. Plasma: Super+Shift+X stops sharing.')
