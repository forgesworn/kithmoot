# Coffee goblin animation

An original editable 3D interpretation of KithMoot's teal coffee goblin sticker.
This reviewed animation supplies the coffee GIF in KithMoot's local catalogue.
It replaces the previous flat rotating/bouncing coffee reaction. New exports
must be reviewed before the packaging script's pinned hashes are updated.

`build_coffee.py` creates the geometry, materials, studio lighting, camera and
six-second performance. From this source folder on the M4, run it with Blender 5.2:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --python build_coffee.py -- /chosen/output save
/Applications/Blender.app/Contents/MacOS/Blender -b /chosen/output/kithmoot-coffee-goblin.blend --python render_validate.py -- /chosen/output
```

The scene uses real meshes and curves, with separate named controls for the
head, eyelids, brows, gaze, pupils, mouth, palms, fingers, arms, ceramic mug,
steam and coffee drops. No image plane or downloaded graphics are used.
Controls use editable Blender object and curve keyframes rather than a skeletal
armature. The character's geometry and materials remain editable in the `.blend`.

The performance is 144 frames at 24 fps: sleepy anticipation, sip, contented
pause and an espresso moustache, caffeine shock with jitter and a spill, guilty
sideways glance, and reset.
Frame 145 closes every animated control to frame 1. The render script checks
that closure and records independently changing controls in its JSON receipt.

The master is a transparent 512-pixel PNG sequence rendered using Cycles Metal
on the M4. Generated `.blend`, frames, previews and encoded review files are
ignored to keep source control small. The exported GIF and static preview are
copied into the app's committed local assets after review; the PNG master
retains full alpha and colour for future export.

`python3 encode_coffee.py /chosen/output` creates a transparent looping GIF,
a lossless alpha WebM master and a dark-backed MP4 for easy viewing. It checks
the GIF frame count and the eight-mebibyte attachment limit, and records sizes,
SHA-256 hashes and FFprobe metadata in an export receipt.

To package a reviewed export, run
`node scripts/build-original-chat-art.mjs --coffee-export /chosen/output`
from the repository root. Without an export folder, the script retains and
verifies the committed coffee animation and preview. It regenerates character
stickers from their original sheets, and never recreates the older flat GIFs.
`node scripts/build-original-chat-art.mjs --check` verifies packaged hashes
without modifying assets.
