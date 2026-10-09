"""Render the editable coffee scene and record genuine independent motion/loop proof."""
import bpy,sys,os,json
out=sys.argv[sys.argv.index('--')+1]
scene=bpy.context.scene
prefs=bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type='METAL';prefs.get_devices()
for d in prefs.devices:d.use=d.type=='METAL'
scene.cycles.device='GPU'
animated=[o for o in scene.objects if o.animation_data]
def snapshot(frame):
    scene.frame_set(frame);bpy.context.view_layer.update()
    result={}
    for o in animated:
        result[o.name]=[v for row in o.matrix_world for v in row]+list(o.scale)
    for o in scene.objects:
        if o.type=='CURVE' and o.name.startswith('ACTOR • bendy arm'):
            result[o.name]=[v for p in o.data.splines[0].bezier_points for v in p.co]
    return result
first=snapshot(1);last=snapshot(145)
error=max(abs(a-b) for name in first for a,b in zip(first[name],last[name]))
assert error<1e-6,(error,'Loop did not close')
poses={str(f):snapshot(f) for f in (1,45,68,91,119,145)}
motion={name:max(abs(a-b) for a,b in zip(first[name],poses['91'][name])) for name in first}
receipt={'renderer':'Blender 5.2.2 Cycles Metal','resolution':[512,512],'alpha':True,'frames':144,'fps':24,'seconds':6,'loop_closure_frame':145,'loop_max_transform_error':error,'animated_objects':len(animated),'meshes':sum(o.type=='MESH' for o in scene.objects),'image_textures':len(bpy.data.images),'motion_at_caffeine_pose':motion,'representative_control_poses':poses,'source':'Original procedurally modelled 3D geometry; no PNG billboard; no external graphics requests.'}
with open(os.path.join(out,'animation-proof.json'),'w') as f:json.dump(receipt,f,indent=2)
os.makedirs(os.path.join(out,'frames'),exist_ok=True)
scene.frame_start=1;scene.frame_end=144;scene.render.filepath=os.path.join(out,'frames','coffee-')
bpy.ops.render.render(animation=True)
