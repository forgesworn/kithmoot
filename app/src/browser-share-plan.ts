import type { AreaRect } from './share-area.js'

export interface BrowserShareState {
  crop: AreaRect
  masks: readonly AreaRect[]
  hidden: boolean
  confirmedSize: { width: number; height: number }
}

export type BrowserSharePlan = { cover: true } | {
  cover: false
  source: AreaRect
  width: number
  height: number
  masks: AreaRect[]
}

const valid = (r: AreaRect): boolean => [r.x, r.y, r.width, r.height].every(Number.isFinite)
  && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0
  && r.x + r.width <= 1 + Number.EPSILON && r.y + r.height <= 1 + Number.EPSILON

/** Source-relative selections, never desktop coordinates. A resize needs fresh consent. */
export function browserSharePlan(state: BrowserShareState, width: number, height: number): BrowserSharePlan {
  if (state.hidden || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 2 || height < 2 || width !== state.confirmedSize.width || height !== state.confirmedSize.height
    || !valid(state.crop) || !state.masks.every(valid)) return { cover: true }
  const crop = state.crop
  const outputWidth = Math.max(2, Math.round(width * crop.width / 2) * 2)
  const outputHeight = Math.max(2, Math.round(height * crop.height / 2) * 2)
  const masks: AreaRect[] = []
  for (const mask of state.masks) {
    // Pad in source pixels and round outwards in output pixels, including crop edges.
    const left = Math.max(crop.x, mask.x - 3 / width)
    const top = Math.max(crop.y, mask.y - 3 / height)
    const right = Math.min(crop.x + crop.width, mask.x + mask.width + 3 / width)
    const bottom = Math.min(crop.y + crop.height, mask.y + mask.height + 3 / height)
    if (right <= left || bottom <= top) continue
    const x = Math.floor((left - crop.x) / crop.width * outputWidth)
    const y = Math.floor((top - crop.y) / crop.height * outputHeight)
    masks.push({ x, y, width: Math.ceil((right - crop.x) / crop.width * outputWidth) - x,
      height: Math.ceil((bottom - crop.y) / crop.height * outputHeight) - y })
  }
  return { cover: false, source: { x: crop.x * width, y: crop.y * height, width: crop.width * width, height: crop.height * height },
    width: outputWidth, height: outputHeight, masks }
}
