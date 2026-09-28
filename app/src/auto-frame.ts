import type { SegmentationMask } from '../../src/video-effects.js'

/**
 * Keeping the person in the middle of their own picture.
 *
 * The background effect already knows where the person is: its mask. This
 * turns that mask into a crop of the finished frame, eased so the picture
 * drifts after somebody rather than following every twitch. It crops pixels
 * the effect has already painted, so it can only ever send less of the room,
 * never more. With no mask to go on (effect off, loading or failed) the crop
 * eases back out to the whole frame.
 *
 * Every rectangle here is a fraction of the frame, 0 to 1 on each axis, and a
 * crop is the same fraction of both axes so the picture keeps its shape.
 */
export interface FrameBox { x: number; y: number; width: number; height: number }

export const WHOLE_FRAME: FrameBox = { x: 0, y: 0, width: 1, height: 1 }

/** Confidence above which a mask pixel counts as the person. */
export const PERSON_CUTOFF = 0.5
/** Less of the frame than this is a stray hand or a false positive. */
export const MIN_PERSON_SHARE = 0.03
/** Mask pixels at either end of the person ignored, so one stray blob at the
 *  edge of the frame does not stretch the box across the room. */
export const TRIM_SHARE = 0.02
/** Never zoom in further than this: a webcam picture gets soft quickly. */
export const MAX_ZOOM = 1.6
/** How much of the crop's width the person should fill. */
export const PERSON_WIDTH_SHARE = 0.55
/** Space kept above the head, as a share of the crop's height. */
export const HEADROOM = 0.1
/** A new crop is only chased once it differs from the current aim by this. */
export const DEAD_BAND = 0.05
/** How far towards its aim the crop moves each frame. */
export const EASE = 0.06
/** Frames without a mask before the crop starts easing back out. */
export const HOLD_FRAMES = 30

/** Where the person is in this mask, or null when nobody clearly is. */
export function personBox(mask: SegmentationMask | null, step = 4): FrameBox | null {
  if (!mask || mask.width <= 0 || mask.height <= 0) return null
  const columns = new Uint32Array(Math.ceil(mask.width / step))
  const rows = new Uint32Array(Math.ceil(mask.height / step))
  let total = 0
  let sampled = 0
  for (let y = 0, row = 0; y < mask.height; y += step, row++) {
    const offset = y * mask.width
    for (let x = 0, column = 0; x < mask.width; x += step, column++) {
      sampled++
      if ((mask.data[offset + x] ?? 0) < PERSON_CUTOFF) continue
      columns[column]!++
      rows[row]!++
      total++
    }
  }
  if (total === 0 || total / sampled < MIN_PERSON_SHARE) return null
  const [left, right] = extent(columns, total)
  const [top, bottom] = extent(rows, total)
  const x = (left * step) / mask.width
  const y = (top * step) / mask.height
  return {
    x, y,
    width: Math.min(1, ((right + 1) * step) / mask.width) - x,
    height: Math.min(1, ((bottom + 1) * step) / mask.height) - y,
  }
}

function extent(counts: Uint32Array, total: number): [number, number] {
  const trim = total * TRIM_SHARE
  let first = 0
  for (let seen = 0; first < counts.length - 1; first++) { seen += counts[first]!; if (seen > trim) break }
  let last = counts.length - 1
  for (let seen = 0; last > first; last--) { seen += counts[last]!; if (seen > trim) break }
  return [first, last]
}

/** The crop that puts this person in the middle with room above their head. */
export function cropFor(person: FrameBox): FrameBox {
  const size = Math.min(1, Math.max(1 / MAX_ZOOM, person.width / PERSON_WIDTH_SHARE))
  const centre = person.x + person.width / 2
  return {
    x: clamp(centre - size / 2, 0, 1 - size),
    y: clamp(person.y - HEADROOM * size, 0, 1 - size),
    width: size,
    height: size,
  }
}

/** Follows the person from frame to frame, slowly. */
export class AutoFramer {
  #current: FrameBox = WHOLE_FRAME
  #aim: FrameBox = WHOLE_FRAME
  #missed = 0

  /** The crop for this frame, given where the person is (or null). */
  next(person: FrameBox | null): FrameBox {
    if (person) {
      this.#missed = 0
      const aim = cropFor(person)
      if (distance(aim, this.#aim) > DEAD_BAND) this.#aim = aim
    } else if (++this.#missed > HOLD_FRAMES) {
      this.#aim = WHOLE_FRAME
    }
    this.#current = {
      x: ease(this.#current.x, this.#aim.x),
      y: ease(this.#current.y, this.#aim.y),
      width: ease(this.#current.width, this.#aim.width),
      height: ease(this.#current.height, this.#aim.height),
    }
    return this.#current
  }

  /** Straight back to the whole frame, as when framing is turned off. */
  reset(): void {
    this.#current = this.#aim = WHOLE_FRAME
    this.#missed = 0
  }
}

function ease(from: number, to: number): number {
  const next = from + (to - from) * EASE
  return Math.abs(to - next) < 0.0005 ? to : next
}

function distance(a: FrameBox, b: FrameBox): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width))
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
