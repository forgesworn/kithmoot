import type { AreaRect } from './share-area.js'

/** Where a contained video's picture sits inside its element, in CSS pixels. */
export interface PictureBox { left: number; top: number; width: number; height: number }

export const WHOLE_PICTURE: AreaRect = { x: 0, y: 0, width: 1, height: 1 }

/** The letterboxed picture of a `object-fit: contain` video. */
export function videoBox(containerWidth: number, containerHeight: number, videoWidth: number, videoHeight: number): PictureBox | null {
  if (![containerWidth, containerHeight, videoWidth, videoHeight].every(value => Number.isFinite(value) && value > 0)) return null
  const scale = Math.min(containerWidth / videoWidth, containerHeight / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  return { left: (containerWidth - width) / 2, top: (containerHeight - height) / 2, width, height }
}

/** The smallest selection, 64 source pixels a side, as a fraction of the picture. */
export function minimumSelection(videoWidth: number, videoHeight: number): { width: number; height: number } {
  return { width: Math.min(1, 64 / videoWidth), height: Math.min(1, 64 / videoHeight) }
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/**
 * Selections are held as fractions of the picture, which is the rect the crop
 * loop takes, so a window resize leaves them on the same source pixels.
 * Deltas are fractions of the picture too.
 */
export function moveSelection(selection: AreaRect, dx: number, dy: number): AreaRect {
  return { ...selection, x: clamp(selection.x + dx, 0, 1 - selection.width), y: clamp(selection.y + dy, 0, 1 - selection.height) }
}

export function resizeSelection(selection: AreaRect, corner: 'nw' | 'ne' | 'sw' | 'se', dx: number, dy: number, minimum: { width: number; height: number }): AreaRect {
  let left = selection.x, top = selection.y
  let right = selection.x + selection.width, bottom = selection.y + selection.height
  if (corner.includes('w')) left = clamp(left + dx, 0, right - minimum.width)
  else right = clamp(right + dx, left + minimum.width, 1)
  if (corner.includes('n')) top = clamp(top + dy, 0, bottom - minimum.height)
  else bottom = clamp(bottom + dy, top + minimum.height, 1)
  return { x: left, y: top, width: right - left, height: bottom - top }
}
