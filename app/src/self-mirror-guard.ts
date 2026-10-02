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

/** What the captured track says it is, and the ids this app's own windows
 *  answer to: the desktop app can say which window was picked. */
export interface CaptureIdentity {
  /** `MediaTrackSettings.deviceId`, `window:<id>:0` for a desktop window. */
  deviceId?: string
  /** Every window of this app, from the desktop bridge. Absent in a browser. */
  ownIds?: readonly string[]
}

/**
 * The same risk from a plain (non-area) share. `displaySurface` is the
 * standard `getDisplayMedia` hint for what was picked -
 * https://developer.mozilla.org/docs/Web/API/MediaTrackSettings/displaySurface.
 * A whole screen (`'monitor'`) carries every KithMoot window on it, and a
 * window (`'window'`) may be KithMoot's own: the desktop app's own window,
 * or the browser window this tab sits in. Neither the system picker nor the
 * browser says which window was chosen, so any window counts. The hint is
 * also missing from some captures (the macOS system picker in the desktop
 * app among them), and a missing hint counts too. Only a single tab
 * (`'browser'`) is safe, because the request excludes this tab
 * (`selfBrowserSurface: 'exclude'`). Reported from a real call on the Mac
 * desktop app: sharing the KithMoot window put the share inside itself.
 *
 * The desktop app can do better for a window. A desktop capture's
 * `deviceId` is the picked window's own capture id, and the app knows its
 * own, so a window that is not KithMoot's keeps its live preview, which is
 * where the sharer draws on it. Withholding it from every window left the
 * person sharing an editor or a slide deck unable to draw on their own share.
 * Anything that cannot be matched, the macOS system picker's answer among
 * them if it carries no id, is still treated as possibly KithMoot.
 */
export function mayShowItself(displaySurface: string | undefined, capture: CaptureIdentity = {}): boolean {
  if (displaySurface === 'browser') return false
  const { deviceId, ownIds } = capture
  if (displaySurface === 'window' && ownIds && deviceId && /^window:\d+:\d+$/.test(deviceId)) return ownIds.includes(deviceId)
  return true
}
