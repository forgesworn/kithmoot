"""Render an editable Donkey scene and record independent acting/loop closure."""
import bpy
import hashlib
import json
import os
import sys

out = os.path.abspath(sys.argv[sys.argv.index('--') + 1])
scene = bpy.context.scene
slug = os.path.basename(out)
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'METAL'
prefs.get_devices()
for device in prefs.devices:
    device.use = device.type == 'METAL'
scene.cycles.device = 'GPU'
objects = [o for o in scene.objects if o.animation_data]


def pose(frame):
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    return {o.name: {'local': list(o.location) + list(o.rotation_euler) + list(o.scale),
                     'world': [v for row in o.matrix_world for v in row]} for o in objects}


first, closure = pose(1), pose(121)
error = max(abs(a - b) for name in first for field in ('local', 'world')
            for a, b in zip(first[name][field], closure[name][field]))
assert error < 1e-6, (error, 'Loop does not close')
motion = {name: 0. for name in first}
poses = {}
for frame in range(1, 121):
    current = pose(frame)
    for name in motion:
        motion[name] = max(motion[name], max(abs(a - b) for a, b in zip(first[name]['local'], current[name]['local'])))
    if frame in (1, 20, 40, 58, 63, 84, 106, 120):
        poses[str(frame)] = current
changing = {name: value for name, value in motion.items() if value > 1e-5}
assert len(changing) >= 12, ('Too few independently changing controls', changing)
assert all(not image.filepath for image in bpy.data.images if image.type != 'RENDER_RESULT'), 'External bitmap texture'
proof = {
    'character': 'Donkey', 'slug': slug, 'renderer': 'Blender 5.2.2 Cycles Metal',
    'resolution': [512, 512], 'rgbaMaster': True, 'frames': 120, 'fps': 24, 'seconds': 5,
    'loopClosureFrame': 121, 'loopMaximumTransformError': error,
    'keyedObjects': len(objects), 'independentlyChangingLocalControls': changing,
    'meshes': sum(o.type == 'MESH' for o in scene.objects),
    'curvesAndEditableText': sum(o.type in ('CURVE', 'FONT') for o in scene.objects),
    'acting': scene['Acting'], 'representativeControlPoses': poses,
    'source': 'Original procedurally modelled editable 3D quadruped. No downloaded models, image planes, provider graphics or external requests.',
}
os.makedirs(os.path.join(out, 'frames'), exist_ok=True)
scene.frame_start = 1
scene.frame_end = 120
scene.render.filepath = os.path.join(out, 'frames', slug + '-')
bpy.ops.render.render(animation=True)
paths = [os.path.join(out, 'frames', slug + '-%04d.png' % f) for f in range(1, 121)]
hashes = [hashlib.sha256(open(p, 'rb').read()).hexdigest() for p in paths]
proof['renderedMasterFrames'] = len(hashes)
proof['distinctMasterFrameHashes'] = len(set(hashes))
assert len(set(hashes)) >= 110, 'Unexpectedly static master sequence'
with open(os.path.join(out, 'animation-proof.json'), 'w') as f:
    json.dump(proof, f, indent=2)
print(json.dumps({k: v for k, v in proof.items() if k != 'representativeControlPoses'}, indent=2))
