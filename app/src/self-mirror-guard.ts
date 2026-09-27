import type { AreaRect } from './share-area.js'

/**
 * Whether the outgoing share is (near enough) a picture of the sharer's
 * whole display - so that any of KithMoot's own on-screen surfaces that
 * themselves sit on that display (the local preview tile, the floating
 * marks window) would show up inside their own captured picture: a hall
 * of mirrors, reported from a real call where the shared area was sized to
 * cover the whole screen.
 *
 * `MARGIN` absorbs the area frame's own border and toolbar - see
 * `AREA_INSET` in `share-area-geometry.mjs` - which would otherwise read a
 * frame dragged flush to the screen's edges as a fraction just under 1 and
 * miss the case entirely. Erring toward treating a very large area as the
 * whole display costs nothing but a paused preview; erring the other way
 * is the bug.
 */
const MARGIN = 0.1

export function coversWholeDisplay(rect: Pick<AreaRect, 'width' | 'height'> | null): boolean {
  return rect !== null && rect.width >= 1 - MARGIN && rect.height >= 1 - MARGIN
}

/**
 * The same risk from a plain (non-area) screen share: `displaySurface` is
 * the standard `getDisplayMedia` hint for what kind of surface was picked -
 * https://developer.mozilla.org/docs/Web/API/MediaTrackSettings/displaySurface -
 * and `'monitor'` means a whole screen, exactly the case a window or a tab
 * share is not.
 */
export function isWholeDisplaySurface(displaySurface: string | undefined): boolean {
  return displaySurface === 'monitor'
}
