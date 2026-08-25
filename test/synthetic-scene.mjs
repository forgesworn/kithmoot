/**
 * A synthetic camera scene, written as Y4M for Chromium's
 * `--use-file-for-fake-video-capture`.
 *
 * Deliberately synthetic. The whole reason this feature exists is that a set
 * of real-device screenshots published a real room, so the test that proves
 * the blur works is not going to be run against one. Nothing here is a
 * photograph of anywhere.
 *
 * The scene is built to be *measurable* rather than pretty:
 *
 * - The background is a fine checkerboard with diagonals over it. High
 *   spatial frequency everywhere, so "is this blurred" is a number (the
 *   variance of a Laplacian) and not an opinion.
 * - The foreground is a head-and-shoulders silhouette with shading and a few
 *   sharp interior marks, so the same number can be taken inside it.
 *
 * A blurred background reads as a large drop in that number outside the
 * silhouette. A working composite reads as the number inside it staying up.
 */

/** Y4M carries 4:2:0 planar YUV, so the chroma planes are half size. */
export function writeScene(width = 640, height = 480, frames = 12) {
  const chromaW = width / 2
  const chromaH = height / 2
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420\n`, 'ascii')
  const parts = [header]

  for (let f = 0; f < frames; f += 1) {
    const y = Buffer.alloc(width * height)
    const u = Buffer.alloc(chromaW * chromaH, 128)
    const v = Buffer.alloc(chromaW * chromaH, 128)

    // Head centre and shoulder line, nudged a pixel or two per frame so the
    // clip is not a still image: a still image would let a broken pipeline
    // pass by simply never drawing again.
    const cx = width / 2 + Math.round(Math.sin((f / frames) * 2 * Math.PI) * 6)
    const headCy = height * 0.32
    const headRx = width * 0.115
    const headRy = height * 0.2
    const shoulderTop = headCy + headRy * 0.95

    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const dx = (px - cx) / headRx
        const dy = (py - headCy) / headRy
        const inHead = dx * dx + dy * dy <= 1

        // Shoulders: a wide, flat arc rising from the bottom edge.
        const sdx = (px - cx) / (width * 0.34)
        const sdy = (py - (shoulderTop + height * 0.42)) / (height * 0.42)
        const inBody = py > shoulderTop && sdx * sdx + sdy * sdy <= 1

        let luma
        if (inHead || inBody) {
          // Shaded so it is not a flat blob: lit from the upper left, which
          // is what a person in front of a window looks like to a segmenter.
          const shade = 1 - 0.35 * Math.min(1, Math.hypot(dx + 0.4, dy + 0.5) / 1.6)
          luma = Math.round(150 * shade + 60)
          // Eyes and mouth: small, hard-edged, and the only high-frequency
          // detail inside the silhouette, so the sharpness measurement taken
          // there is measuring the composite and not the shading.
          const eyeY = headCy - headRy * 0.1
          const mouthY = headCy + headRy * 0.42
          const eyeDx = Math.abs(px - cx) - headRx * 0.36
          if (inHead && Math.abs(py - eyeY) < 5 && Math.abs(eyeDx) < 7) luma = 30
          if (inHead && Math.abs(py - mouthY) < 4 && Math.abs(px - cx) < headRx * 0.42) luma = 45
        } else {
          // Checkerboard plus diagonals: busy at every scale a blur touches.
          const check = ((px >> 3) + (py >> 3)) % 2 === 0 ? 210 : 45
          const diagonal = (px + py) % 24 < 3 ? 140 : 0
          luma = Math.min(255, check + diagonal)
        }
        y[py * width + px] = luma
      }
    }

    // A warm cast on the silhouette and a cool one on the background, so the
    // two regions are also told apart by colour if anyone looks at a frame.
    for (let py = 0; py < chromaH; py += 1) {
      for (let px = 0; px < chromaW; px += 1) {
        const fx = px * 2
        const fy = py * 2
        const dx = (fx - cx) / headRx
        const dy = (fy - headCy) / headRy
        const sdx = (fx - cx) / (width * 0.34)
        const sdy = (fy - (shoulderTop + height * 0.42)) / (height * 0.42)
        const person = dx * dx + dy * dy <= 1 || (fy > shoulderTop && sdx * sdx + sdy * sdy <= 1)
        u[py * chromaW + px] = person ? 108 : 150
        v[py * chromaW + px] = person ? 150 : 110
      }
    }

    parts.push(Buffer.from('FRAME\n', 'ascii'), y, u, v)
  }

  return Buffer.concat(parts)
}
