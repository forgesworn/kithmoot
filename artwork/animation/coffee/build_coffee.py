"""Original KithMoot coffee goblin: editable geometry and six-second acting loop.

Run with Blender 5.2: blender -b --python build_coffee.py -- /output [preview|render]
All geometry, materials, controls and animation are generated locally.
"""
import bpy, math, os, sys
from mathutils import Vector
args = sys.argv[sys.argv.index('--')+1:]
OUT = args[0]
MODE = args[1] if len(args)>1 else 'preview'
os.makedirs(OUT, exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'; prefs.get_devices()
    for d in prefs.devices: d.use = d.type == 'METAL'
    scene.cycles.device = 'GPU'
except Exception: pass
scene.render.resolution_x = scene.render.resolution_y = 512
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = True
scene.render.fps = 24
scene.frame_start = 1; scene.frame_end = 144
scene.world.color = (.16,.16,.16)
scene.view_settings.view_transform = 'AgX'

def material(name, colour, rough=.4, metallic=0):
    m=bpy.data.materials.new(name); m.diffuse_color=(*colour,1); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*colour,1)
    p.inputs['Roughness'].default_value=rough; p.inputs['Metallic'].default_value=metallic
    p.inputs['Specular IOR Level'].default_value=.26
    return m
teal=material('Skin • lagoon teal',(.009,.34,.28),.48)
teal_light=material('Soft nose and eyelids',(.02,.39,.32),.48)
pink=material('Ear blush',(.57,.17,.20),.58)
dark=material('Charcoal horns eyebrows and shoes',(.015,.020,.026),.53)
white=material('Eyes • warm porcelain',(.91,.86,.78),.25)
iris=material('Eyes • hazel',(.17,.08,.033),.2)
black=material('Pupil and mouth',(.009,.005,.005),.2)
cream=material('Cup • glazed ivory',(.87,.77,.61),.2)
coffee=material('Coffee • glossy espresso',(.067,.018,.005),.14)
steam_mat=material('Steam • warm cream',(.85,.83,.75),.7)
tongue=material('Tongue',(.69,.19,.24),.5)
eye_shadow=material('Soft teal eye shadow',(.018,.08,.075),.66)
def surface_detail(mat,scale,strength,distance):
    nodes=mat.node_tree.nodes;links=mat.node_tree.links
    noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=scale;noise.inputs['Detail'].default_value=3
    bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=strength;bump.inputs['Distance'].default_value=distance
    links.new(noise.outputs['Fac'],bump.inputs['Height']);links.new(bump.outputs['Normal'],nodes.get('Principled BSDF').inputs['Normal'])
for m in(teal,teal_light,pink):
    m.node_tree.nodes.get('Principled BSDF').inputs['Subsurface Weight'].default_value=.055
    surface_detail(m,85,.13,.018)
surface_detail(dark,42,.20,.022)
surface_detail(cream,120,.045,.012)
surface_detail(iris,14,.13,.014)

def empty(name, loc=(0,0,0), parent=None):
    ob=bpy.data.objects.new(name,None); scene.collection.objects.link(ob); ob.location=loc
    if parent: ob.parent=parent
    return ob
def ball(name,loc,scale,mat,parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=40,ring_count=24,location=(0,0,0))
    o=bpy.context.object; o.name=name; o.location=loc; o.scale=scale
    if parent: o.parent=parent
    o.data.materials.append(mat)
    for p in o.data.polygons: p.use_smooth=True
    return o
def tube(name,points,radius,mat,parent=None):
    c=bpy.data.curves.new(name,'CURVE'); c.dimensions='3D'; c.resolution_u=20
    c.bevel_depth=radius; c.bevel_resolution=5
    s=c.splines.new('BEZIER'); s.bezier_points.add(len(points)-1)
    for p,co in zip(s.bezier_points,points): p.co=co; p.handle_left_type=p.handle_right_type='AUTO'
    o=bpy.data.objects.new(name,c); scene.collection.objects.link(o); c.materials.append(mat)
    if parent: o.parent=parent
    return o
def torus(name,loc,major,minor,mat,parent=None,rot=(0,0,0)):
    bpy.ops.mesh.primitive_torus_add(major_segments=64,minor_segments=16,major_radius=major,minor_radius=minor)
    o=bpy.context.object; o.name=name; o.location=loc; o.rotation_euler=rot
    if parent:o.parent=parent
    o.data.materials.append(mat)
    for p in o.data.polygons:p.use_smooth=True
    return o
def tapered(name,points,radii,mat,parent):
    verts=[]; faces=[]; n=16
    for i,(p,r) in enumerate(zip(points,radii)):
        tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(i-1,0)])
        tangent.normalize(); ax=tangent.cross(Vector((0,1,0))).normalized(); ay=tangent.cross(ax).normalized()
        for j in range(n):
            v=Vector(p)+r*(math.cos(j*2*math.pi/n)*ax+math.sin(j*2*math.pi/n)*ay); verts.append(v)
    for i in range(len(points)-1):
        for j in range(n):faces.append((i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j))
    faces.extend([tuple(reversed(range(n))),tuple((len(points)-1)*n+j for j in range(n))])
    me=bpy.data.meshes.new(name); me.from_pydata(verts,[],faces); me.update()
    ob=bpy.data.objects.new(name,me);scene.collection.objects.link(ob);ob.parent=parent;me.materials.append(mat)
    mod=ob.modifiers.new('Organic smooth surface','SUBSURF');mod.levels=2
    for p in me.polygons:p.use_smooth=True
    return ob

root=empty('ACTOR • whole body')
body=ball('Round belly',(0,.10,1.33),(.73,.51,.72),teal,root)
head=empty('ACTOR • head', (0,0,2.42),root)
ball('Large round goblin head',(0,0,0),(.99,.66,.94),teal,head)
for side in (-1,1):
    # A stretched, upward-swept leaf has a smooth thick rim around its inset bowl.
    ear=ball('Swept pointed goblin ear',(side*1.02,.015,.20),(.39,.14,.39),teal,head)
    for v in ear.data.vertices:
        vx=v.co.x
        if side*vx>0:
            v.co.x=v.co.x*1.28+side*.35*(side*vx)**3
            v.co.z+=.54*side*vx
            v.co.y*=max(.22,1-.6*side*vx)
    inner=ball('Warm inner ear',(side*1.07,-.11,.22),(.27,.05,.27),pink,head)
    for v in inner.data.vertices:
        vx=v.co.x
        if side*vx>0:
            v.co.x*=1.25;v.co.z+=.53*side*vx
    tapered('Swept charcoal horn',[(side*.57,.13,.70),(side*.66,.13,.94),(side*.65,.16,1.19),(side*.76,.22,1.36)], [.24,.20,.115,.008],dark,head)
    foot=ball('Soft charcoal boot',(side*.55,-.26,.64),(.37,.49,.33),dark,root)
    tube('Boot seam',[(side*.84,-.50,.63),(side*.6,-.73,.60),(side*.35,-.50,.59)],.015,teal_light,root)

eyes=[]; lids=[]; brows=[]; pupils=[]
for side in (-1,1):
    x=side*.43
    ball('Soft eye socket',(x,-.535,.15),(.43,.17,.36),eye_shadow,head)
    ball('Porcelain eyeball',(x,-.67,.18),(.375,.18,.31),white,head)
    eye=empty('ACTOR • gaze',(x,-.842,.16),head)
    ball('Hazel iris',(0,0,0),(.158,.024,.17),iris,eye)
    pupil=ball('Black pupil',(0,-.019,0),(.075,.018,.102),black,eye)
    ball('Eye catchlight',(-.039,-.038,.064),(.035,.012,.034),white,eye)
    pupils.append(pupil);eyes.append(eye)
    lid=ball('ACTOR • upper eyelid',(x,-.713,.40),(.408,.19,.21),teal_light,head);lids.append(lid)
    brow=empty('ACTOR • eyebrow',(x,-.65,.64),head)
    tube('Expressive charcoal eyebrow',[(-.28,0,-.025),(-.10,-.028,.052),(.12,-.01,.06),(.27,.04,-.01)],.095,dark,brow);brows.append(brow)
    ball('Rounded brow end',(-.28,0,-.025),(.093,.093,.093),dark,brow)
    ball('Rounded brow end',(.27,.04,-.01),(.093,.093,.093),dark,brow)
ball('Button nose',(0,-.695,-.04),(.20,.16,.16),teal_light,head)
for s in(-1,1):ball('Tiny nostril',(s*.07,-.827,-.10),(.023,.012,.016),teal,head)
mouth=ball('ACTOR • mouth opening',(0,-.64,-.30),(.21,.048,.064),black,head)
lip=tube('Lower lip',[(-.20,-.62,-.335),(0,-.66,-.37),(.20,-.62,-.335)],.035,teal_light,head)
mouth_tongue=ball('Small tongue',(0,-.701,-.33),(.08,.012,.024),tongue,head)
mustache=ball('ACTOR • espresso moustache',(0,-.721,-.207),(.13,.02,.034),coffee,head)
for side in(-1,1):
    ball('Sleepy cheek',(side*.68,-.50,-.13),(.16,.018,.085),teal_light,head)

cup=empty('PROP • mug and independent hands',(0,-1.02,1.38),root)
# Closed thick-walled open cup, with an actual interior and recessed liquid.
verts=[];faces=[];N=96
profile=[(.40,-.48),(.46,-.42),(.46,.43),(.445,.48),(.395,.48),(.39,.40),(.37,-.37),(.0,-.37),(.0,-.48)]
for r,z in profile:
    for j in range(N):verts.append((r*math.cos(2*math.pi*j/N),r*math.sin(2*math.pi*j/N),z))
for i in range(len(profile)-1):
    for j in range(N):faces.append((i*N+j,i*N+(j+1)%N,(i+1)*N+(j+1)%N,(i+1)*N+j))
me=bpy.data.meshes.new('Ceramic mug mesh');me.from_pydata(verts,[],faces);me.update()
o=bpy.data.objects.new('Ivory ceramic mug',me);scene.collection.objects.link(o);o.parent=cup;me.materials.append(cream)
for p in me.polygons:p.use_smooth=True
torus('Rounded glazed lip',(0,0,.455),.418,.032,cream,cup)
ball('Glossy full coffee surface',(0,0,.447),(.389,.389,.006),coffee,cup)
handle=torus('Ceramic handle',(.49,0,.02),.24,.068,cream,cup,(math.pi/2,0,0));handle.scale=(.86,1,1.20)
bean=ball('Coffee bean emblem',(0,-.464,-.04),(.14,.02,.22),coffee,cup);bean.rotation_euler[1]=.35
tube('Bean split',[(-.05,-.491,-.24),(-.045,-.493,-.09),(.05,-.494,.04),(.054,-.493,.15)],.014,cream,cup)
hands=[]
for side in(-1,1):
    hand=empty('ACTOR • gripping hand',(side*.47,-.14,-.02),cup);hands.append(hand)
    ball('Palm',(0,0,0),(.18,.17,.23),teal,hand)
    for n in range(3):
        finger=ball('Independent curled finger',(side*-.025,-.15,.14-n*.13),(.18,.09,.07),teal_light,hand)
        finger.rotation_euler[1]=side*.15
    thumb=ball('Thumb',(side*-.07,-.045,.24),(.095,.115,.17),teal,hand);thumb.rotation_euler[1]=side*.45
# Arms are curved and keyed in mesh control points; they follow the cup each frame.
arms=[]
for side in(-1,1):
    arms.append(tube('ACTOR • bendy arm',[(side*.58,-.13,1.66),(side*.78,-.46,1.35),(side*.47,-1.13,1.38)],.15,teal,root))
steam=[]
for i in range(2):
    steam.append(tube('ACTOR • curling steam',[(i*.13-.10,0,.45),(i*.13-.15,.03,.70),(i*.13+.02,0,.88),(i*.13-.08,.03,1.04)],.011,steam_mat,cup))
drops=[]
for n in range(7):
    d=ball('ACTOR • airborne coffee drop '+str(n),(0,0,0),(.032,.035,.06),coffee,root);drops.append(d)

def key(ob,prop,val,f):
    setattr(ob,prop,val);ob.keyframe_insert(data_path=prop,frame=f)
def lerp(a,b,t):return a+(b-a)*t
def smooth(t):return max(0,min(1,t))**2*(3-2*max(0,min(1,t)))
def tween(f,a,b,x,y):return lerp(x,y,smooth((f-a)/(b-a)))

for f in range(1,145):
    # 1–30 sleepy anticipation; 31–56 sip; 57–75 satisfied pause;
    # 76–111 wild caffeine reaction/spill; 112–128 guilty glance; reset.
    lift=tween(f,24,46,0,1)-tween(f,56,72,0,1)
    hyper=smooth((f-77)/7)*(1-smooth((f-108)/12))
    reset=smooth((f-128)/16)
    bob=.008*math.sin(f*.1)+hyper*.080*math.sin(f*2.2)
    roll=hyper*.07*math.sin(f*1.8)
    key(root,'location',(hyper*.065*math.sin(f*1.5),0,bob),f)
    key(root,'rotation_euler',(0,roll,hyper*.04*math.sin(f*1.2)),f)
    key(head,'rotation_euler',(-lift*.16+hyper*.075*math.sin(f*2.6),hyper*.10*math.sin(f*2.0),.025*math.sin(f*.09)*(1-hyper)),f)
    key(head,'scale',(1-hyper*.018,1,1+hyper*.035),f)
    key(cup,'location',(hyper*.03*math.sin(f*2.8),-1.02-lift*.12,1.38+lift*.67+hyper*.035*math.sin(f*2.4)),f)
    key(cup,'rotation_euler',(-lift*.34,hyper*.12*math.sin(f*1.8),hyper*.07*math.sin(f*1.7)),f)
    awake=smooth((f-75)/5)*(1-reset)
    sleepy=.22*(1-awake)
    satisfied=smooth((f-57)/3)*(1-smooth((f-73)/3))
    for i,(eye,lid,brow,pupil) in enumerate(zip(eyes,lids,brows,pupils)):
        s=(-1,1)[i]
        key(lid,'location',(s*.43,-.713,.43-sleepy-satisfied*.08),f)
        key(lid,'scale',(.408,.19,.21*(1-awake*.56)),f)
        gaze=(.085*smooth((f-112)/4)*(1-reset))
        key(eye,'location',(s*.43+gaze,-.842,.16+awake*.018-satisfied*.05),f)
        key(pupil,'scale',(.075*(1-awake*.40),.018,.102*(1-awake*.3)),f)
        key(brow,'location',(s*.43,-.65,.64+awake*.16-satisfied*.04),f)
        key(brow,'rotation_euler',(0,s*(.13-awake*.28),0),f)
    # tiny sleepy sigh, smile after sip, oversized caffeine gasp, awkward return
    key(mouth,'scale',(.21+awake*.055,.048,.064+hyper*.15+satisfied*.035),f)
    key(mouth_tongue,'scale',(.08,.012,.024+hyper*.022),f)
    stain=smooth((f-52)/4)*(1-reset)
    key(mustache,'scale',(.13*max(.001,stain),.02*max(.001,stain),.034*max(.001,stain)),f)
    for i,st in enumerate(steam):
        key(st,'scale',(1,1,max(.001,1-smooth((f-75)/7)+reset)),f)
        key(st,'rotation_euler',(0,0,.22*math.sin(f*.10+i)),f)
    for i,hand in enumerate(hands):
        s=(-1,1)[i]
        key(hand,'rotation_euler',(hyper*.08*math.sin(f*2.5+i),s*.1,hyper*.035*math.sin(f*1.8)),f)
        for n,finger in enumerate(c for c in hand.children if 'finger' in c.name):
            key(finger,'rotation_euler',(hyper*.05*math.sin(f*1.7+n),s*.15+hyper*.13*math.sin(f*1.3+n),0),f)
    scene.frame_set(f);bpy.context.view_layer.update()
    for i,arm in enumerate(arms):
        s=(-1,1)[i]
        wrist=root.matrix_world.inverted()@(cup.matrix_world@Vector((s*.47,-.12,0)))
        pts=[(s*.58,-.13,1.66),(s*(.76+lift*.04),-.52-lift*.10,1.40+lift*.36),wrist]
        for p,co in zip(arm.data.splines[0].bezier_points,pts):p.co=co;p.keyframe_insert('co',frame=f)
    for n,d in enumerate(drops):
        t=(f-(85+n*2))/18
        visible=0<=t<=1
        key(d,'scale',(.041,.045,.077) if visible else (.00001,.00001,.00001),f)
        key(d,'location',(.25+(.18+n*.06)*t,-1.04-.12*t,1.83+.45*t-1.08*t*t),f)
        key(d,'rotation_euler',(0,.5*t,n*.25),f)

# A loop-safe resting pose; each control closes exactly at frame 145.
for ob in [root,head,cup,mouth,mouth_tongue,mustache,*eyes,*lids,*brows,*pupils,*steam,*hands,*drops,*(c for hand in hands for c in hand.children if 'finger' in c.name)]:
    if ob.animation_data and ob.animation_data.action:
        scene.frame_set(1)
        for prop in ('location','rotation_euler','scale'):ob.keyframe_insert(data_path=prop,frame=145)
for arm in arms:
    scene.frame_set(1)
    for p in arm.data.splines[0].bezier_points:p.keyframe_insert('co',frame=145)

def light(name,loc,energy,size,colour):
    bpy.ops.object.light_add(type='AREA',location=loc);ob=bpy.context.object;ob.name=name
    ob.data.energy=energy;ob.data.shape='DISK';ob.data.size=size;ob.data.color=colour
    ob.rotation_euler=(Vector((0,0,2))-ob.location).to_track_quat('-Z','Y').to_euler()
light('Studio • large warm key',(-3,-4,6),450,4,(1,.86,.73))
light('Studio • soft cool fill',(3,-3,3.5),250,3,(.69,.87,1))
light('Studio • teal rim',(1,2,5),600,3,(.5,1,.91))
bpy.ops.object.camera_add(location=(0,-9,3.45));cam=bpy.context.object
cam.rotation_euler=(Vector((0,-.15,2.08))-cam.location).to_track_quat('-Z','Y').to_euler()
cam.data.type='ORTHO';cam.data.ortho_scale=4.25;scene.camera=cam;cam.name='Camera • square sticker master'
scene.frame_set(1)
scene['Art direction']='Teal coffee goblin based on the original KithMoot coffee sticker. Real editable 3D geometry; no image billboard.'
scene['Acting beats']='Sleepy anticipation / drink / satisfied pause / caffeine gasp and jitter / spill / guilty glance / sleepy reset'
scene['Loop']='144 frames at 24 fps; frame 145 matches frame 1'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'kithmoot-coffee-goblin.blend'))
if MODE=='render':
    scene.render.filepath=os.path.join(OUT,'frames','coffee-');os.makedirs(os.path.join(OUT,'frames'),exist_ok=True)
    bpy.ops.render.render(animation=True)
elif MODE=='preview':
    for frame in [1,45,68,91,119]:
        scene.frame_set(frame);scene.render.filepath=os.path.join(OUT,'preview-%03d.png'%frame)
        bpy.ops.render.render(write_still=True)
