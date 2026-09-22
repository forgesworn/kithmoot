/**
 * Match a captured desktop source to the display beneath the area frame.
 * X11 normally supplies display_id. Some Linux capturers omit it; accepting
 * that source is safe only when there is exactly one source and one display.
 */
export function sourceForDisplay(sources, display, displays) {
  const exact = sources.find(source => source.display_id === String(display.id))
  if (exact) return exact
  if (sources.length === 1 && displays.length === 1) return sources[0]
  return undefined
}
