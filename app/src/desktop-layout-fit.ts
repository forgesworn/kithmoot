/**
 * How a shared screen is sized on a desktop-sized window.
 *
 * The CSS next door puts a person's camera on the left of a row and their
 * own screen on the right of it, and that much is pure layout. What CSS
 * cannot do on its own is the last bit: give the screen a box that is
 * exactly the shape of the picture inside it - no black bands top and
 * bottom - while ALSO keeping every sharer's row on the screen at once.
 *
 * Those two wants pull against each other. A box shaped by the picture is
 * as tall as its width divides by; two of those stacked are routinely
 * taller than the window, and the second one goes off the bottom. The fix
 * is to bound each row's height first and then take the widest box of the
 * right shape that fits inside that bound - so a second sharer costs the
 * first one some size rather than costing them their place on screen.
 *
 * Flexbox will not do this for you. A flex item's main size is settled
 * before its cross size, so `max-height` on a `<video>` in a flex row
 * clamps the height and leaves the width where it was, which is precisely
 * the letterboxing this exists to avoid. So the arithmetic lives here, in
 * two pure functions with no DOM in them, and `fitShares` below is the
 * thin layer that measures the room and writes the answer back as pixels.
 */

/** Every camera tile in the room is this wide, sharing or not, so two
 *  people's faces are the same size as each other. Mirrored by `--tile-cam`
 *  in style.css, which is what a browser tab gets and what everybody gets
 *  for the moment before this runs. */
export const CAMERA_TILE_PX = 288

/**
 * How far the camera is allowed to come down in a short window.
 *
 * It has to be allowed to come down at all, because the camera is the floor
 * under its own row. A 288px camera is 216px tall, and with the name line
 * and the buttons beside it that is 281px of row before the shared screen
 * has had a single pixel. Two of those did not fit an 880px-tall window,
 * and what happened instead was the worst possible outcome: the second
 * person's row was clipped off the bottom of the scrolling stage, present
 * in every measurement and invisible to the person sitting there.
 *
 * So the camera comes down instead - the same amount for everybody in the
 * room, because two faces the same size as each other is the point - and
 * never below this.
 */
export const CAMERA_MIN_PX = 240

/** The camera's shape, and the shape of the name plate that stands in for
 *  it when a sharer has no camera on. */
export const CAMERA_ASPECT = 4 / 3

/** Below this a share is not worth looking at, so the room is allowed to
 *  scroll rather than shrink it any further. */
export const MIN_SHARE_HEIGHT = 140

/** A few pixels held back so a rounding error cannot be the thing that
 *  puts the last row over the edge. */
export const ROW_SAFETY_PX = 6

export interface Box {
  width: number
  height: number
}

/**
 * How tall each stacked share row may be.
 *
 * `available` is the height the rows have between them, `rows` how many
 * there are, `gap` the space between two of them. The floor matters: with
 * five people sharing, an honest division would leave each of them a
 * sliver, and a room that scrolls is better than five unreadable strips.
 */
export function shareRowBudget(available: number, rows: number, gap: number, minRow = MIN_SHARE_HEIGHT): number {
  if (rows <= 0) return 0
  const usable = available - gap * (rows - 1)
  return Math.max(minRow, usable / rows)
}

/**
 * The biggest box of shape `aspect` (width over height) that fits inside
 * both bounds.
 *
 * Width first, because a share is read across: the box is as wide as the
 * row leaves it, and only gives width back when the height that implies
 * would not fit. `minHeight` is the floor from `shareRowBudget`, applied
 * the same way - and if honouring it would push the box wider than the row,
 * the row wins and the caller gets something that fits.
 */
export function fitShare(options: { aspect: number; maxWidth: number; maxHeight: number; minHeight?: number }): Box {
  const aspect = Number.isFinite(options.aspect) && options.aspect > 0 ? options.aspect : 16 / 9
  const maxWidth = Math.max(1, options.maxWidth)
  const maxHeight = Math.max(1, options.maxHeight)
  const minHeight = Math.max(1, options.minHeight ?? MIN_SHARE_HEIGHT)

  let width = maxWidth
  let height = width / aspect
  if (height > maxHeight) {
    height = maxHeight
    width = height * aspect
  }
  if (height < minHeight) {
    height = minHeight
    width = height * aspect
    if (width > maxWidth) {
      width = maxWidth
      height = width / aspect
    }
  }
  return { width: Math.round(width), height: Math.round(height) }
}

/**
 * One camera width for the whole room, given what a row may be worth and
 * what the row spends on everything that is not a picture.
 *
 * The camera is never wider than `CAMERA_TILE_PX`, because a face is
 * context for the screen beside it and not the other half of it, and never
 * narrower than `CAMERA_MIN_PX`, because below that it stops being a face.
 * Between those it is whatever leaves the row's height to the screen.
 */
export function cameraWidthFor(budget: number, chrome: number): number {
  const forHeight = Math.max(0, budget - chrome)
  return Math.round(Math.min(CAMERA_TILE_PX, Math.max(CAMERA_MIN_PX, forHeight * CAMERA_ASPECT)))
}

/** The pixel gap a computed style reports, or 0 when it reports `normal`. */
function gapOf(value: string): number {
  const px = Number.parseFloat(value)
  return Number.isFinite(px) ? px : 0
}

function isSharer(tile: Element): boolean {
  return tile.querySelector('video.screenPreview') !== null
}

/** A tile's own picture holders - one per device, so a person on a laptop
 *  and a phone has two of them. */
function mediasOf(tile: HTMLElement): HTMLElement[] {
  return [...tile.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('media'))
}

/** The width above which the room is rows of people rather than a grid of
 *  tiles. Matches the `@media` the sharing layout lives in, in style.css. */
export const DESKTOP_QUERY = '(min-width: 900px)'

/** Hand the room back to the stylesheet. */
function clearFit(room: HTMLElement): void {
  room.style.removeProperty('--tile-cam')
  for (const share of room.querySelectorAll<HTMLElement>('video.screenPreview')) {
    if (!share.style.width && !share.style.height) continue
    share.style.removeProperty('width')
    share.style.removeProperty('height')
    share.style.removeProperty('max-width')
    share.style.removeProperty('max-height')
  }
}

/**
 * Measure the room and give every shared screen in it a box.
 *
 * Deliberately idempotent and cheap to call again: it writes a pixel width
 * and height only when they differ from what is already on the element, so
 * a run that changes nothing observes nothing and cannot feed itself.
 */
export function fitShares(room: HTMLElement, bottom: number): void {
  const tiles = [...room.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
  const sharers = tiles.filter(isSharer)
  // Narrow the installed window past the desktop breakpoint and the room
  // goes back to the stacked, full-width layout in style.css - which cannot
  // win against pixels left on the elements by a wider moment, because
  // inline styles beat every stylesheet there is. So they come off.
  if (!matchMedia(DESKTOP_QUERY).matches) return clearFit(room)
  // Nobody sharing any more: the same argument, for the same reason - a
  // width left behind on a `<video>` outlives the share it was measured for.
  if (sharers.length === 0) return clearFit(room)

  const roomStyle = getComputedStyle(room)
  const rowGap = gapOf(roomStyle.rowGap)

  // Rows of people who are not sharing pack together above or below; they
  // keep their own height and the shares divide what is left.
  const others = tiles.filter(tile => !isSharer(tile) && tile.querySelector('video'))
  const otherRow = others.length > 0 ? Math.max(...others.map(tile => tile.getBoundingClientRect().height)) + rowGap : 0

  const top = room.getBoundingClientRect().top
  const available = Math.max(0, bottom - top - otherRow - ROW_SAFETY_PX)
  const budget = shareRowBudget(available, sharers.length, rowGap)

  // Everything in a row that is not a picture - the name, the track chips,
  // the expand button, the tile's own padding - measured rather than
  // assumed, because it differs between your own tile and somebody else's,
  // and between a verified name and an unverified one. The worst case sets
  // the camera, so that every row fits and every camera stays the same.
  const chromes = new Map<HTMLElement, number>()
  for (const tile of sharers) {
    const medias = mediasOf(tile)
    if (medias.length === 0) continue
    chromes.set(tile, Math.max(0, tile.getBoundingClientRect().height - medias.reduce((sum, media) => sum + media.getBoundingClientRect().height, 0)))
  }
  const tileCam = `${cameraWidthFor(budget, Math.max(0, ...chromes.values()))}px`
  if (room.style.getPropertyValue('--tile-cam') !== tileCam) room.style.setProperty('--tile-cam', tileCam)

  for (const tile of sharers) {
    const medias = mediasOf(tile)
    if (medias.length === 0) continue
    const chrome = chromes.get(tile) ?? 0
    const perMedia = Math.max(MIN_SHARE_HEIGHT, (budget - chrome) / medias.length)

    for (const media of medias) {
      const share = media.querySelector('video.screenPreview') as HTMLVideoElement | null
      if (!share) continue
      const natural = share.videoWidth > 0 && share.videoHeight > 0 ? share.videoWidth / share.videoHeight : 0
      // Nothing decoded yet: leave the CSS fallback alone and come back on
      // `loadedmetadata`, which is what `installShareFitting` listens for.
      if (natural === 0) continue

      const camera = media.querySelector('video:not(.screenPreview)') as HTMLVideoElement | null
      // No camera: the name stand-in sits there instead, at `--tile-cam`.
      const cameraWidth = camera ? camera.getBoundingClientRect().width : parseFloat(tileCam)
      const innerGap = gapOf(getComputedStyle(media).columnGap)
      const maxWidth = media.clientWidth - cameraWidth - innerGap

      const box = fitShare({ aspect: natural, maxWidth, maxHeight: perMedia })
      const width = `${box.width}px`
      const height = `${box.height}px`
      if (share.style.width === width && share.style.height === height) continue
      share.style.width = width
      share.style.height = height
      // The fallback bounds in style.css keep an undecoded share inside the
      // row before this runs; once there is a real box they would only clip
      // it, so they come off.
      share.style.maxWidth = 'none'
      share.style.maxHeight = 'none'
    }
  }
}

/** Hand a set of camera-only videos back to the stylesheet. */
function clearCameraFit(tiles: Iterable<HTMLElement>): void {
  for (const tile of tiles) {
    const video = tile.querySelector('video:not(.screenPreview)') as HTMLVideoElement | null
    if (!video || (!video.style.width && !video.style.height)) continue
    video.style.removeProperty('width')
    video.style.removeProperty('height')
  }
}

/**
 * The `live` pane's own version of `fitShares`: nobody is sharing a
 * screen, so there is no row to divide, but the tile still has to fill the
 * box it was given rather than sit at its default size with the rest of
 * the pane empty around it - the owner's original complaint, once the
 * pane had grown to hold it. Same idea as `fitShares`, in miniature: the
 * biggest box of the camera's own shape that fits both the width a tile
 * has (the room's width, shared evenly) and the height the pane has,
 * written onto the `<video>` directly rather than through `--tile-cam`,
 * because `--tile-cam` only ever shrank to a fixed ceiling and here there
 * is no ceiling - the tile grows until a bound stops it.
 *
 * Scoped to `live` and to a room with nobody sharing: `fitShares` already
 * owns the sharing case, `peek`'s thumbnails are fixed by CSS `!important`
 * on purpose, and the two must never both be writing to the same element.
 */
export function fitCameraOnly(room: HTMLElement, bottom: number): void {
  const tiles = [...room.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.querySelector('video:not(.screenPreview)') !== null && !isSharer(child))
  if (!matchMedia(DESKTOP_QUERY).matches || room.classList.contains('sharing') ||
    document.documentElement.dataset.callPane !== 'live' || tiles.length === 0) return clearCameraFit(tiles)

  const roomStyle = getComputedStyle(room)
  const rowGap = gapOf(roomStyle.columnGap)
  const top = room.getBoundingClientRect().top
  const availableHeight = Math.max(1, bottom - top - ROW_SAFETY_PX)
  const availableWidth = Math.max(1, room.clientWidth - rowGap * (tiles.length - 1))
  const perTileWidth = availableWidth / tiles.length

  const box = fitShare({ aspect: CAMERA_ASPECT, maxWidth: perTileWidth, maxHeight: availableHeight, minHeight: CAMERA_MIN_PX })
  const width = `${box.width}px`
  const height = `${box.height}px`
  for (const tile of tiles) {
    const video = tile.querySelector('video:not(.screenPreview)') as HTMLVideoElement
    if (video.style.width === width && video.style.height === height) continue
    video.style.width = width
    video.style.height = height
  }
}

/**
 * Keep `fitShares` in step with the things that change its answer: the
 * window, the chat drawer, a person arriving or leaving, and a share whose
 * picture has only just arrived or has changed shape mid-call.
 *
 * `loadedmetadata` and a `<video>`'s `resize` do not bubble, so both are
 * caught in the capture phase on the room instead of being wired to each
 * element as it appears - there is no lifecycle here to hang that on, and
 * `render()` in main.ts moves these elements between tiles.
 */
export function installShareFitting(room: HTMLElement, stage: HTMLElement | null): () => void {
  let queued = 0
  const run = (): void => {
    queued = 0
    if (!room.isConnected) return
    const stageBottom = stage ? stage.getBoundingClientRect().bottom : window.innerHeight
    const bottom = Math.min(stageBottom, window.innerHeight)
    fitShares(room, bottom)
    fitCameraOnly(room, bottom)
  }
  const schedule = (): void => {
    if (queued) return
    queued = requestAnimationFrame(run)
  }

  const observer = new MutationObserver(schedule)
  // Children only, plus the class `render()` toggles when somebody starts
  // or stops sharing. Not attributes in the subtree: the pixel widths this
  // writes are attribute changes on the very elements being watched.
  observer.observe(room, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  const sizes = new ResizeObserver(schedule)
  sizes.observe(stage ?? room)
  room.addEventListener('loadedmetadata', schedule, true)
  room.addEventListener('resize', schedule, true)
  window.addEventListener('resize', schedule)
  // `fitCameraOnly` reads `data-call-pane` on the way in and out of `live`,
  // and that change happens on `<html>`, well outside `room` - the pane
  // settling from `peek`'s fixed thumbnails to `live`'s grown tile, or back,
  // is exactly the moment this has to run again.
  const paneObserver = new MutationObserver(schedule)
  paneObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-call-pane'] })
  schedule()

  return () => {
    observer.disconnect()
    sizes.disconnect()
    paneObserver.disconnect()
    room.removeEventListener('loadedmetadata', schedule, true)
    room.removeEventListener('resize', schedule, true)
    window.removeEventListener('resize', schedule)
    if (queued) cancelAnimationFrame(queued)
  }
}
