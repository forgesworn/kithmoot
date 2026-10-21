/**
 * Remembering the main window's size and position (design-calm-stage7, A6).
 *
 * Pure, like `app-menu.mjs`: nothing here imports `electron`, so `node:test`
 * covers it. `main.mjs` reads and writes the file and passes in the displays.
 */

const DEFAULTS = { width: 1320, height: 880, minWidth: 900, minHeight: 640 }
const MIN_VISIBLE = 100

const whole = value => Number.isSafeInteger(value)

/** The saved record, or undefined when it is anything but finite integers and a boolean. */
export function readWindowState(saved) {
  if (typeof saved !== 'object' || saved === null) return undefined
  const { x, y, width, height, maximized } = saved
  if (![x, y, width, height].every(whole)) return undefined
  return { x, y, width, height, maximized: maximized === true }
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

/**
 * Bounds to open with: the saved ones when at least 100 by 100 px of them lie
 * inside one display's work area (clamped to the minimums and to that area),
 * otherwise the defaults with no position, which Electron centres.
 */
export function restoreBounds(saved, displays, sizes = DEFAULTS) {
  const fallback = { width: sizes.width, height: sizes.height }
  const state = readWindowState(saved)
  if (!state || !Array.isArray(displays)) return fallback
  for (const display of displays) {
    const area = display?.workArea
    if (!area || ![area.x, area.y, area.width, area.height].every(Number.isFinite)) continue
    const visibleWidth = overlap(state.x, state.x + state.width, area.x, area.x + area.width)
    const visibleHeight = overlap(state.y, state.y + state.height, area.y, area.y + area.height)
    if (visibleWidth < MIN_VISIBLE || visibleHeight < MIN_VISIBLE) continue
    const width = Math.min(Math.max(state.width, sizes.minWidth), Math.max(area.width, sizes.minWidth))
    const height = Math.min(Math.max(state.height, sizes.minHeight), Math.max(area.height, sizes.minHeight))
    return { x: state.x, y: state.y, width, height }
  }
  return fallback
}
