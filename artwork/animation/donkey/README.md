# Donkey acted animations

Three original, editable 3D interpretations of the bundled orange Donkey
character. The reference is app/public/emoji/crypto-donkey.png; the character
name shown to people is **Donkey**.
The supplied transparent reference PNG has SHA-256
01d6743d4f962057d0e9d4e545c6d11eb54c824fd1570ec47c381c10f80f4df2.

The quadruped retains its orange coat, tall peach-inset ears, cream muzzle,
expressive amber eyes, tousled charcoal mane and tail tuft, and four dark hooves.
The geometry, materials, lighting, performance and coin are created locally by
build_donkey.py. No downloaded models, image planes, provider graphics or
external graphics requests are used.

The performances are separately acted rather than transformations of a flat
picture: snort and belly laugh; articulated front-hoof facepalm with an ear flop
and sideways glance; and an independently spinning gold Bitcoin coin tossed,
caught and celebrated. Face, jaw, eyes, brows, ears, body, articulated legs,
hooves and tail have editable Blender object keyframes. The coin and glints
have independent controls.

On the M4, with Blender 5.2.2 and local FFmpeg:

~~~sh
/Applications/Blender.app/Contents/MacOS/Blender -b --python build_donkey.py -- /chosen/output all preview
/Applications/Blender.app/Contents/MacOS/Blender -b /chosen/output/donkey-laugh/donkey-laugh.blend --python render_validate.py -- /chosen/output/donkey-laugh
python3 encode_donkey.py /chosen/output/donkey-laugh
~~~

Repeat the render/export commands for donkey-facepalm and donkey-bitcoin.
Each master is 120 transparent 512px RGBA PNG frames at 24 fps, five seconds.
Frame 121 closes every keyed transform exactly to frame 1. The render receipt
records local controls that independently change, closure error, representative
poses and distinct master frame hashes.

Exports include a transparent, infinitely looping GIF below eight mebibytes,
a matching transparent PNG from the expressive hero pose for reduced motion and
stickers, a lossless alpha WebM, and an MP4 with a dark review background.
Export receipts record sizes, hashes and independently probed frame counts.

Generated scenes, frames, review files and receipts stay outside source control.
Only the reviewed GIF/PNG assets are copied into app/public/chat-art/; catalogue
metadata and native integration are owned by the integrating change.
