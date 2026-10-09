"""Export locally rendered Donkey RGBA masters using local FFmpeg."""
import hashlib
import json
import os
import shutil
import subprocess
import sys

out = os.path.abspath(sys.argv[1])
slug = os.path.basename(out)
ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
assert ffmpeg and ffprobe, 'Local FFmpeg and FFprobe required'
frames = os.path.join(out, 'frames', slug + '-%04d.png')
assert len([p for p in os.listdir(os.path.join(out, 'frames')) if p.endswith('.png')]) == 120
hero = {'donkey-laugh': 58, 'donkey-facepalm': 63, 'donkey-bitcoin': 84}[slug]
shutil.copyfile(os.path.join(out, 'frames', slug + '-%04d.png' % hero), os.path.join(out, slug + '.png'))


def run(args):
    subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'warning', '-y', *args], check=True)


base = ['-framerate', '24', '-start_number', '1', '-i', frames]
run([*base, '-filter_complex',
     '[0:v]split[a][b];[a]palettegen=max_colors=160:reserve_transparent=1[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=96',
     '-loop', '0', os.path.join(out, slug + '.gif')])
run([*base, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-lossless', '1',
     '-auto-alt-ref', '0', '-metadata:s:v:0', 'alpha_mode=1', os.path.join(out, slug + '-transparent.webm')])
run([*base, '-f', 'lavfi', '-i', 'color=c=0x14212a:s=512x512:r=24:d=5',
     '-filter_complex', '[1:v][0:v]overlay=shortest=1,format=yuv420p',
     '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', os.path.join(out, slug + '-review.mp4')])
proof = {'character': 'Donkey', 'slug': slug, 'frames': 120, 'fps': 24, 'seconds': 5,
         'pngPreviewFrame': hero, 'files': {}}
for name in (slug + '.gif', slug + '.png', slug + '-transparent.webm', slug + '-review.mp4', slug + '.blend'):
    path = os.path.join(out, name)
    data = open(path, 'rb').read()
    item = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if name.endswith(('.gif', '.webm', '.mp4')):
        item['probe'] = json.loads(subprocess.check_output([
            ffprobe, '-v', 'error', '-count_frames', '-show_entries',
            'stream=codec_name,width,height,nb_read_frames,duration:format=duration', '-of', 'json', path]))
    proof['files'][name] = item
gif = proof['files'][slug + '.gif']
assert gif['bytes'] < 8 * 1024 * 1024, 'GIF exceeds eight mebibytes'
assert gif['probe']['streams'][0]['nb_read_frames'] == '120'
assert gif['probe']['streams'][0]['width'] == gif['probe']['streams'][0]['height'] == 512
assert b'NETSCAPE2.0' in open(os.path.join(out, slug + '.gif'), 'rb').read(), 'GIF loop extension absent'
with open(os.path.join(out, 'export-proof.json'), 'w') as f:
    json.dump(proof, f, indent=2)
print(json.dumps(proof, indent=2))
