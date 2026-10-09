"""Original editable Donkey: a quadruped with three separately acted loops.

Blender 5.2: blender -b --python build_donkey.py -- OUTPUT [laugh|facepalm|bitcoin|all] [preview|save]
No image planes, downloaded models, provider graphics or external requests.
"""
import bpy
import math
import os
import sys
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
OUT = os.path.abspath(args[0])
VARIANT = args[1] if len(args) > 1 else 'all'
MODE = args[2] if len(args) > 2 else 'preview'
FRAMES = 120
FPS = 24


def smooth(a, b, t):
    u = min(1., max(0., (t - a) / (b - a)))
    return u * u * (3 - 2 * u)


def window(a, b, c, d, t):
    return smooth(a, b, t) * (1 - smooth(c, d, t))


def build(variant):
    out = os.path.join(OUT, 'donkey-' + variant)
    os.makedirs(out, exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 40
    scene.cycles.use_denoising = True
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'METAL'
    scene.cycles.device = 'GPU'
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    scene.render.fps = FPS
    scene.frame_start = 1
    scene.frame_end = FRAMES
    scene.world.color = (.16, .16, .16)
    scene.view_settings.view_transform = 'AgX'

    def material(name, rgb, roughness=.5, metal=0, detail=False):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        m.diffuse_color = (*rgb, 1)
        p = m.node_tree.nodes.get('Principled BSDF')
        p.inputs['Base Color'].default_value = (*rgb, 1)
        p.inputs['Roughness'].default_value = roughness
        p.inputs['Metallic'].default_value = metal
        p.inputs['Specular IOR Level'].default_value = .25
        if detail:
            p.inputs['Subsurface Weight'].default_value = .035
            p.inputs['Sheen Weight'].default_value = .18
            n = m.node_tree.nodes.new('ShaderNodeTexNoise')
            n.inputs['Scale'].default_value = 105
            n.inputs['Detail'].default_value = 3
            bump = m.node_tree.nodes.new('ShaderNodeBump')
            bump.inputs['Strength'].default_value = .15
            bump.inputs['Distance'].default_value = .012
            m.node_tree.links.new(n.outputs['Fac'], bump.inputs['Height'])
            m.node_tree.links.new(bump.outputs['Normal'], p.inputs['Normal'])
        return m

    orange = material('Donkey • warm orange velvet coat', (.95, .12, .003), .57, detail=True)
    orange_light = material('Donkey • golden face and eyelids', (1., .18, .008), .57, detail=True)
    peach = material('Donkey • peach ear bowls', (.98, .43, .19), .6, detail=True)
    cream = material('Donkey • cream muzzle', (.89, .59, .29), .57, detail=True)
    hair = material('Donkey • tousled charcoal mane', (.025, .029, .034), .7)
    hair_light = material('Donkey • subtle charcoal hair strands', (.053, .058, .065), .68)
    hoof_mat = material('Donkey • charcoal hooves', (.027, .032, .04), .48)
    eye_white = material('Donkey • warm porcelain eyes', (.97, .94, .83), .25)
    iris_mat = material('Donkey • deep amber irises', (.24, .073, .008), .3)
    dark = material('Donkey • pupils nostrils mouth', (.017, .006, .002), .4)
    tongue_mat = material('Donkey • warm tongue', (.69, .14, .15), .5)
    blush = material('Donkey • embarrassed warm cheeks', (.87, .18, .045), .63)
    tear_mat = material('Donkey • laughter tears', (.29, .74, .91), .16)
    gold = material('Coin • warm minted gold', (.97, .58, .085), .26, .8)
    gold_dark = material('Coin • embossed Bitcoin gold', (.49, .205, .009), .3, .72)
    glint_mat = material('Coin • celebratory gold glints', (1., .85, .3), .25, .4)

    def empty(name, loc=(0, 0, 0), parent=None):
        o = bpy.data.objects.new(name, None)
        scene.collection.objects.link(o)
        o.location = loc
        o.parent = parent
        return o

    def ball(name, loc, scale, mat, parent=None, segments=32):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=20)
        o = bpy.context.object
        o.name = name
        o.location = loc
        o.scale = scale
        o.parent = parent
        o.data.materials.append(mat)
        for p in o.data.polygons:
            p.use_smooth = True
        return o

    def tube(name, points, radius, mat, parent=None):
        c = bpy.data.curves.new(name, 'CURVE')
        c.dimensions = '3D'
        c.resolution_u = 18
        c.bevel_depth = radius
        c.bevel_resolution = 4
        s = c.splines.new('BEZIER')
        s.bezier_points.add(len(points) - 1)
        for p, co in zip(s.bezier_points, points):
            p.co = co
            p.handle_left_type = p.handle_right_type = 'AUTO'
        o = bpy.data.objects.new(name, c)
        scene.collection.objects.link(o)
        o.parent = parent
        c.materials.append(mat)
        return o

    def tapered(name, points, radii, mat, parent):
        verts, faces, sides = [], [], 16
        for i, (p, radius) in enumerate(zip(points, radii)):
            tangent = Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(i - 1, 0)])
            tangent.normalize()
            axis = tangent.cross(Vector((0, 1, .2))).normalized()
            other = tangent.cross(axis).normalized()
            for j in range(sides):
                angle = j * 2 * math.pi / sides
                verts.append(Vector(p) + radius * (math.cos(angle) * axis + math.sin(angle) * other))
        for i in range(len(points) - 1):
            for j in range(sides):
                faces.append((i * sides + j, i * sides + (j + 1) % sides,
                              (i + 1) * sides + (j + 1) % sides, (i + 1) * sides + j))
        faces.extend([tuple(reversed(range(sides))),
                      tuple((len(points) - 1) * sides + j for j in range(sides))])
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        o = bpy.data.objects.new(name, mesh)
        scene.collection.objects.link(o)
        o.parent = parent
        mesh.materials.append(mat)
        mod = o.modifiers.new('Soft organic surface', 'SUBSURF')
        mod.levels = 2
        for p in mesh.polygons:
            p.use_smooth = True
        return o

    root = empty('ACTOR • quadruped body')
    body = ball('Donkey • rounded barrel', (-.20, .04, 1.25), (1.05, .50, .65), orange, root)
    torso = [body,
             ball('Donkey • round rump', (-.86, .025, 1.23), (.45, .44, .50), orange, root),
             ball('Donkey • upright chest', (.48, .03, 1.44), (.48, .445, .64), orange, root),
             ball('Donkey • curved neck', (.72, .025, 1.88), (.365, .355, .62), orange, root)]
    # A smooth voxel union removes the primitive intersection seams at the shoulder.
    bpy.ops.object.select_all(action='DESELECT')
    for part in torso:
        part.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    remesh = body.modifiers.new('Seamless rounded torso', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = .045
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    soften = body.modifiers.new('Soft shoulder transitions', 'SMOOTH')
    soften.factor = 1.1
    soften.iterations = 5
    bpy.ops.object.modifier_apply(modifier=soften.name)
    for p in body.data.polygons:
        p.use_smooth = True
    head = empty('ACTOR • expressive donkey head', (.82, -.015, 2.33), root)
    head.scale = (1.17, 1.13, 1.12)
    ball('Donkey • rounded forehead', (0, 0, .18), (.46, .385, .59), orange_light, head)
    ball('Donkey • soft lower face', (0, -.15, -.10), (.38, .32, .39), orange_light, head)
    ball('Donkey • cream upper muzzle', (0, -.465, -.11), (.395, .255, .26), cream, head)
    jaw = empty('ACTOR • hinged lower jaw', (0, -.40, -.28), head)
    ball('Donkey • lower cream muzzle', (0, -.14, -.046), (.285, .16, .070), cream, jaw)
    mouth = ball('ACTOR • mouth cavity', (0, -.716, -.24), (.235, .042, .035), dark, head)
    tongue = ball('ACTOR • tongue', (0, -.743, -.31), (.13, .018, .026), tongue_mat, head)
    teeth = empty('ACTOR • donkey incisors', (0, -.744, -.16), head)
    for side in (-1, 1):
        ball('Donkey • upper incisor', (side * .06, 0, -.03), (.057, .025, .05), eye_white, teeth)
        ball('Donkey • oval nostril', (side * .16, -.690, -.055), (.031, .018, .043), dark, head)
        for i in range(3):
            ball('Donkey • muzzle whisker freckle', (side * (.25 + (i % 2) * .037), -.671 - .01 * (i % 2), -.13 - .035 * (i // 2)), (.011, .006, .010), dark, head, 16)
    tube('Donkey • gentle smile', [(-.23, -.687, -.235), (0, -.730, -.27), (.23, -.687, -.235)], .017, dark, head)
    lids, brows, gazes, pupils, ears, cheeks, tears, eyeballs = [], [], [], [], [], [], [], []
    for side in (-1, 1):
        x = side * .215
        ball('Donkey • soft eye socket', (x, -.302, .33), (.193, .123, .235), orange, head)
        eyeball = ball('ACTOR • porcelain eye ' + str(side), (x, -.365, .34), (.171, .094, .218), eye_white, head)
        gaze = empty('ACTOR • gaze ' + str(side), (x + .015, -.454, .345), head)
        ball('Donkey • amber iris', (0, 0, 0), (.073, .017, .11), iris_mat, gaze)
        pupil = ball('ACTOR • pupil ' + str(side), (0, -.017, 0), (.041, .012, .077), dark, gaze)
        ball('Donkey • main eye highlight', (-.023, -.032, .047), (.021, .010, .025), eye_white, gaze)
        ball('Donkey • tiny eye highlight', (.017, -.032, -.035), (.009, .008, .009), eye_white, gaze, 16)
        lid = ball('ACTOR • upper eyelid ' + str(side), (x, -.352, .595), (.184, .112, .09), orange_light, head)
        brow = empty('ACTOR • eyebrow ' + str(side), (x, -.365, .605), head)
        tube('Donkey • expressive charcoal brow', [(-.13, .016, -.018), (0, -.035, .025), (.13, .016, -.018)], .031, hair, brow)
        ear = empty('ACTOR • ear ' + str(side), (side * .235, .065, .645), head)
        outer = ball('Donkey • tall leaf ear', (0, 0, .43), (.205, .115, .60), orange_light, ear)
        inner = ball('Donkey • peach inner ear', (0, -.077, .44), (.144, .055, .50), peach, ear)
        for ob in (outer, inner):
            for v in ob.data.vertices:
                v.co.x *= 1 - .28 * v.co.z
                v.co.y += .13 * v.co.z * v.co.z
                if v.co.z > .55:
                    v.co.x *= 1 - .22 * (v.co.z - .55)
        cheek = ball('ACTOR • blush ' + str(side), (side * .31, -.344, .05), (.10, .012, .05), blush, head)
        tear = ball('ACTOR • laugh tear ' + str(side), (side * .31, -.355, .25), (.00001, .00001, .00001), tear_mat, head)
        lids.append(lid); brows.append(brow); gazes.append(gaze); pupils.append(pupil)
        ears.append(ear); cheeks.append(cheek); tears.append(tear); eyeballs.append(eyeball)
    # Separate curved mesh tufts follow the crown and neck, rather than a smooth black cap.
    for i in range(4):
        x = -.20 + i * .12
        high = .96 + .07 * math.sin(i * 1.5)
        tapered('Donkey • thick tousled quiff', [(x, .03, .64), (x - .045, -.015, high),
                                                (x + .08, -.17, high + .045), (x + .17, -.30, .72)],
                [.14, .135, .11, .006], hair, head)
        tube('Donkey • fine quiff strand', [(x - .015, -.07, .74), (x, -.075, high),
                                           (x + .105, -.20, high - .035)], .007, hair_light, head)
    for i in range(7):
        z = 1.52 + .12 * i
        tapered('Donkey • neck mane tuft', [(.89, .23, z), (1.0, .29, z + .10), (1.02, .26, z + .19)],
                [.095, .07, .006], hair, root)
    tail = empty('ACTOR • tail swish', (-1.14, .08, 1.43), root)
    tube('Donkey • curved orange tail', [(0, 0, 0), (-.20, -.015, .10), (-.34, -.025, .40)], .054, orange, tail)
    ball('Donkey • full tail tuft base', (-.33, -.025, .50), (.13, .105, .19), hair, tail)
    for i in range(4):
        dx = (i - 1.5) * .045
        tapered('Donkey • tousled tail tuft', [(-.33 + dx, -.025, .38), (-.34 + dx, -.035, .60),
                                              (-.23 + dx, -.04, .77 - .035 * i)],
                [.085, .071, .004], hair, tail)
    legs = []
    for x, y in ((-.85, .27), (-.76, -.27), (.66, .265), (.68, -.285)):
        upper = ball('ACTOR • upper leg ' + str(len(legs)), (0, 0, 0), (.13, .13, .45), orange, root)
        lower = ball('ACTOR • lower leg ' + str(len(legs)), (0, 0, 0), (.10, .10, .40), orange_light, root)
        hoof = ball('ACTOR • hoof ' + str(len(legs)), (x, y, .17), (.205, .218, .14), hoof_mat, root)
        for v in hoof.data.vertices:
            if v.co.z < -.55:
                v.co.z = -.55
        tube('Donkey • hoof coronet', [(-.15, -.10, .08), (0, -.185, .10), (.15, -.10, .08)], .009, hair_light, hoof)
        legs.append((upper, lower, hoof, x, y))

    coin = empty('PROP • independently tossed Bitcoin coin', (1.36, -.64, 1.35), root)
    bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=.33, depth=.065)
    disc = bpy.context.object
    disc.name = 'Bitcoin • solid milled gold coin'
    disc.parent = coin
    disc.location = (0, 0, 0)
    disc.data.materials.append(gold)
    bevel = disc.modifiers.new('Minted rounded edge', 'BEVEL')
    bevel.width = .013
    bevel.segments = 3
    for p in disc.data.polygons:
        p.use_smooth = True
    for face in (-1, 1):
        bpy.ops.mesh.primitive_torus_add(major_segments=64, minor_segments=12, major_radius=.283, minor_radius=.010)
        ring = bpy.context.object
        ring.name = 'Bitcoin • face rim'
        ring.parent = coin
        ring.location = (0, 0, face * .038)
        ring.data.materials.append(gold_dark)
    # The Bitcoin symbol is an editable extruded B plus the two vertical strokes.
    curve = bpy.data.curves.new('Bitcoin embossed B', 'FONT')
    curve.body = 'B'
    curve.align_x = 'CENTER'
    curve.align_y = 'CENTER'
    curve.size = .42
    curve.extrude = .005
    curve.bevel_depth = .003
    text = bpy.data.objects.new('Bitcoin • embossed B', curve)
    scene.collection.objects.link(text)
    text.parent = coin
    text.location = (0, -.012, .04)
    curve.materials.append(gold_dark)
    for x in (-.052, .009):
        tube('Bitcoin • double vertical stroke', [(x, -.22, .047), (x, .22, .047)], .011, gold_dark, coin)
    for i in range(48):
        a = i * math.tau / 48
        tube('Bitcoin • milled edge', [(.329 * math.cos(a), .329 * math.sin(a), -.018),
                                      (.329 * math.cos(a), .329 * math.sin(a), .018)], .004, gold_dark, coin)
    stars = []
    for i in range(3):
        star = empty('PROP • celebration glint ' + str(i), parent=root)
        verts = [(0, 0, 0)]
        for j in range(8):
            a = j * math.pi / 4
            radius = .10 if j % 2 == 0 else .028
            verts.append((radius * math.cos(a), 0, radius * math.sin(a)))
        faces = [(0, j + 1, (j + 1) % 8 + 1) for j in range(8)]
        mesh = bpy.data.meshes.new('Gold glint mesh')
        mesh.from_pydata(verts, [], faces)
        mesh.materials.append(glint_mat)
        ob = bpy.data.objects.new('Gold glint', mesh)
        scene.collection.objects.link(ob)
        ob.parent = star
        stars.append(star)
    coin.scale = (1, 1, 1) if variant == 'bitcoin' else (.00001, .00001, .00001)
    animated = set()

    def key(o, prop, value, frame):
        setattr(o, prop, value)
        o.keyframe_insert(data_path=prop, frame=frame)
        animated.add(o)

    def segment(o, a, b, radius, frame):
        d = Vector(b) - Vector(a)
        key(o, 'location', (Vector(a) + Vector(b)) / 2, frame)
        key(o, 'rotation_euler', d.to_track_quat('Z', 'Y').to_euler(), frame)
        key(o, 'scale', (radius, radius, d.length / 2 + .055), frame)

    coin_base_rotation = Vector((3.8, -8, 3.8)).to_track_quat('Z', 'Y').to_euler()
    for frame in range(1, FRAMES + 1):
        t = (frame - 1) / FPS
        breath = .012 * math.sin(math.tau * t / 5)
        laugh = window(.45, 1.20, 3.25, 4.55, t) if variant == 'laugh' else 0
        palm = window(.80, 1.75, 3.50, 4.65, t) if variant == 'facepalm' else 0
        victory = window(2.90, 3.35, 4.0, 4.70, t) if variant == 'bitcoin' else 0
        look_up = window(.60, 1.1, 2.45, 3.0, t) if variant == 'bitcoin' else 0
        chuckle = laugh * math.sin(15 * t)
        snort = window(.55, .72, .82, 1.05, t) if variant == 'laugh' else 0
        root_z = breath + .037 * chuckle + .085 * victory * abs(math.sin(12 * t))
        key(root, 'location', (0, 0, root_z), frame)
        key(root, 'rotation_euler', (0, .014 * chuckle, .025 * chuckle), frame)
        key(body, 'scale', (1 + .022 * chuckle, 1 + .030 * laugh, 1 + .022 * chuckle), frame)
        key(head, 'rotation_euler', (-.18 * laugh + .045 * chuckle + .16 * palm - .20 * look_up,
                                     .035 * chuckle + .12 * palm, -.06 * palm + .045 * laugh * math.sin(7 * t)), frame)
        key(jaw, 'rotation_euler', (.30 * laugh + .14 * snort + .09 * victory, 0, 0), frame)
        key(mouth, 'scale', (.255 + .045 * laugh, .042, .0001 + .135 * laugh + .030 * victory), frame)
        key(mouth, 'location', (0, -.716, -.24 - .03 * laugh), frame)
        key(teeth, 'scale', (1, 1, 1) if laugh > .04 or victory > .4 else (.00001,) * 3, frame)
        key(tongue, 'scale', (.13, .018, .026) if laugh > .08 else (.00001,) * 3, frame)
        blink = window(.18, .23, .29, .34, t) + window(4.45, 4.50, 4.56, 4.61, t)
        for i, side in enumerate((-1, 1)):
            squint = min(1, blink + .66 * laugh + (.2 if side == -1 else .38) * palm)
            key(lids[i], 'location', (side * .215, -.368, .595 - .235 * squint), frame)
            key(lids[i], 'scale', (.184, .112, .09 + .046 * squint), frame)
            key(eyeballs[i], 'scale', (.171, .094, .218 * (1 - .38 * laugh)), frame)
            key(brows[i], 'rotation_euler', (0, side * (.14 * laugh - .15 * palm), side * .10 * palm), frame)
            key(brows[i], 'location', (side * .215, -.365, .605 + .028 * laugh - .032 * palm + .055 * look_up), frame)
            key(gazes[i], 'location', (side * .215 + .015 - .035 * palm, -.454, .345 + .043 * look_up), frame)
            key(pupils[i], 'scale', (.041 * (1 + .12 * look_up), .012, .077 * (1 + .1 * look_up) * (1 - .38 * laugh)), frame)
            key(ears[i], 'rotation_euler', (.10 * laugh * math.sin(11 * t + i) + .82 * palm * (1 if side == -1 else .45),
                                           side * (.20 + .19 * laugh - .06 * victory),
                                           side * (.08 + .23 * laugh + .38 * palm - .05 * victory)), frame)
            key(cheeks[i], 'scale', (.10, .012, .05) if palm > .08 else (.00001,) * 3, frame)
            tear = laugh * window(1.0, 1.4, 3.0, 3.7, t)
            key(tears[i], 'scale', (.035 * tear + .00001, .016 * tear + .00001, .066 * tear + .00001), frame)
            key(tears[i], 'location', (side * .31, -.365, .23 - .095 * laugh * (1 + math.sin(5 * t + i)) / 2), frame)
        key(tail, 'rotation_euler', (.25 * laugh * math.sin(10 * t), .09 * math.sin(math.tau * t / 5), .32 * victory * math.sin(8 * t)), frame)
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        face_target = root.matrix_world.inverted() @ (head.matrix_world @ Vector((.015, -.40, .57)))
        for i, (upper, lower, hoof, x, y) in enumerate(legs):
            shoulder = (x, y, 1.27 if i < 2 else 1.50)
            end = Vector((x + (.08 if i < 2 else .02), y - .015, .17))
            if i == 3:
                target = face_target if variant == 'facepalm' else Vector((1.25, -.68, 1.25))
                raise_hoof = palm if variant == 'facepalm' else (window(.38, .90, 3.7, 4.7, t) if variant == 'bitcoin' else 0)
                end = end.lerp(target, raise_hoof)
                # A two-bone elbow keeps the lifted foreleg articulated rather
                # than stretching one straight lower leg all the way to the face.
                start = Vector(shoulder)
                direction = end - start
                distance = max(.001, direction.length)
                axis = direction.normalized()
                length_a, length_b = .84, .77
                if distance > length_a + length_b - .005:
                    stretch = distance / (length_a + length_b - .005)
                    length_a *= stretch
                    length_b *= stretch
                along = (length_a * length_a - length_b * length_b + distance * distance) / (2 * distance)
                height = math.sqrt(max(0., length_a * length_a - along * along))
                bend = Vector((1, -.38, 0))
                bend = (bend - axis * bend.dot(axis)).normalized()
                lifted_elbow = start + axis * along + bend * height
                knee = Vector((x + .055, y - .06, .75)).lerp(lifted_elbow, raise_hoof)
            else:
                end.z += .025 * victory * (1 + math.sin(12 * t + i * math.pi)) / 2
                knee = Vector((x + .065, y, .73))
            segment(upper, shoulder, knee, .123, frame)
            segment(lower, knee, end, .093, frame)
            key(hoof, 'location', end, frame)
            key(hoof, 'rotation_euler', (.24 * palm if i == 3 else 0, -.20 * victory if i == 3 else 0, 0), frame)
        if variant == 'bitcoin':
            # The coin leaves the raised hoof, follows a real arc, spins, then lands.
            toss = min(1, max(0, (t - 1.00) / 1.70))
            airborne = 1.00 < t < 2.70
            hoof_pos = legs[3][2].location
            pos = Vector(hoof_pos) + Vector((.06, -.02, .31))
            if airborne:
                pos = Vector((1.32 + .20 * math.sin(math.pi * toss), -.71, 1.56 + 2.25 * 4 * toss * (1 - toss)))
            key(coin, 'location', pos, frame)
            key(coin, 'rotation_euler', (coin_base_rotation.x + (math.tau * 2 * toss if airborne else 0),
                                        coin_base_rotation.y, coin_base_rotation.z + .09 * victory * math.sin(9 * t)), frame)
        for i, star in enumerate(stars):
            amount = victory * max(0, math.sin(8 * t + i * 2)) if variant == 'bitcoin' else 0
            key(star, 'location', (1.25 + (i - 1) * .45, -.72, 2.1 + i * .31), frame)
            key(star, 'scale', (amount + .00001,) * 3, frame)

    # Explicitly close every keyed transform at the next, unrendered frame.
    scene.frame_set(1)
    for o in animated:
        for prop in ('location', 'rotation_euler', 'scale'):
            o.keyframe_insert(data_path=prop, frame=FRAMES + 1)

    def light(name, location, energy, size, colour):
        bpy.ops.object.light_add(type='AREA', location=location)
        o = bpy.context.object
        o.name = name
        o.data.energy = energy
        o.data.shape = 'DISK'
        o.data.size = size
        o.data.color = colour
        o.rotation_euler = (Vector((0, 0, 1.8)) - o.location).to_track_quat('-Z', 'Y').to_euler()

    light('Studio • soft warm key', (-3, -4, 6), 500, 4, (1, .90, .77))
    light('Studio • cool soft fill', (4, -3, 4), 280, 3, (.77, .88, 1))
    light('Studio • warm orange rim', (0, 3, 5), 650, 3, (1, .76, .47))
    bpy.ops.object.camera_add(location=(3.8, -8, 4.0))
    camera = bpy.context.object
    camera.name = 'Camera • square transparent Donkey master'
    camera.rotation_euler = (Vector((0, -.02, 1.98)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 5.02
    scene.camera = camera
    scene['Character'] = 'Donkey — original orange quadruped interpretation of the bundled ForgeMoji character'
    scene['Acting'] = {
        'laugh': 'Anticipatory blink; nostril snort; open-jawed belly laugh with tears, flapping ears and tail; recover.',
        'facepalm': 'Knowing look; articulated front hoof reaches forehead; embarrassed ear flop, blush and sideways gaze; lower hoof and reset.',
        'bitcoin': 'Raise gold Bitcoin coin; toss with independent two-turn spin and high ballistic arc; catch; delighted victory bounce and glints; reset.',
    }[variant]
    scene['Loop'] = '120 rendered frames at 24fps; every keyed transform closes at frame121'
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, 'donkey-' + variant + '.blend'))
    if MODE == 'preview':
        hero = {'laugh': 58, 'facepalm': 63, 'bitcoin': 84}[variant]
        for frame in ((1, 45, hero) if variant == 'bitcoin' else (1, hero)):
            scene.frame_set(frame)
            scene.render.filepath = os.path.join(out, 'hero-%03d.png' % frame)
            bpy.ops.render.render(write_still=True)


for selected in ('laugh', 'facepalm', 'bitcoin') if VARIANT == 'all' else (VARIANT,):
    build(selected)
