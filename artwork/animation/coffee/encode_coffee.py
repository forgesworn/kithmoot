"""Create review exports from the Blender RGBA master using local FFmpeg."""
import sys,os,subprocess,json,hashlib,shutil
out=os.path.abspath(sys.argv[1]);ffmpeg=shutil.which('ffmpeg');ffprobe=shutil.which('ffprobe')
assert ffmpeg and ffprobe,'FFmpeg and FFprobe must be installed'
frames=os.path.join(out,'frames','coffee-%04d.png')
assert len([f for f in os.listdir(os.path.join(out,'frames')) if f.endswith('.png')])==144
shutil.copyfile(os.path.join(out,'frames','coffee-0001.png'),os.path.join(out,'coffee-preview.png'))
def run(args):subprocess.run([ffmpeg,'-hide_banner','-loglevel','warning','-y',*args],check=True)
base=['-framerate','24','-start_number','1','-i',frames]
run([*base,'-filter_complex','[0:v]split[a][b];[a]palettegen=max_colors=128:reserve_transparent=1[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=96', '-loop','0',os.path.join(out,'coffee.gif')])
run([*base,'-c:v','libvpx-vp9','-pix_fmt','yuva420p','-lossless','1','-auto-alt-ref','0','-metadata:s:v:0','alpha_mode=1',os.path.join(out,'coffee-transparent.webm')])
run([*base,'-f','lavfi','-i','color=c=0x14212a:s=512x512:r=24:d=6','-filter_complex','[1:v][0:v]overlay=shortest=1,format=yuv420p','-c:v','libx264','-crf','18','-movflags','+faststart',os.path.join(out,'coffee-review.mp4')])
receipt={}
for name in ('coffee.gif','coffee-transparent.webm','coffee-review.mp4','kithmoot-coffee-goblin.blend'):
    path=os.path.join(out,name);data=open(path,'rb').read()
    receipt[name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
    if name.endswith(('.gif','.webm','.mp4')):
        receipt[name]['probe']=json.loads(subprocess.check_output([ffprobe,'-v','error','-count_frames','-show_entries','stream=codec_name,width,height,nb_read_frames,duration:format=duration','-of','json',path]))
assert receipt['coffee.gif']['bytes']<8*1024*1024,'GIF exceeds composer attachment limit'
assert receipt['coffee.gif']['probe']['streams'][0]['nb_read_frames']=='144'
with open(os.path.join(out,'export-proof.json'),'w') as f:json.dump(receipt,f,indent=2)
print(json.dumps(receipt,indent=2))
