/**
 * How the installed window divides itself between the call, the
 * conversation, Shared Work and the rooms rail.
 *
 * The complaint this answers, in the owner's words: "if work and chat are
 * enabled, chat is too small and is unusable. yet there's loads of free
 * space in call (we aren't running a call)."
 *
 * Both halves of that were real, and they had different causes.
 *
 * The free space was an empty call panel taking a whole column because the
 * row it sits in gives it everything the drawer does not want. Nothing in
 * it - no call, no faces - and it still took the width. That is fixed by
 * state rather than arithmetic: see `callPaneLive` in call-stance.ts and
 * `[data-call-pane="resting"]` in desktop.css, which turn the panel into
 * one strip and hand the room back.
 *
 * The unusable chat was arithmetic. Shared Work is a fixed 28rem panel at
 * the right of the window and the rooms rail is 13rem at the left, and what
 * was left over went to the call with the conversation taking a percentage
 * of the remainder: 32% of 616px is 197px, which is not a conversation. So
 * the order of precedence is written down here instead. Chat has a floor in
 * pixels and takes it before anything else; the call pane keeps enough to
 * be a call pane; and when the window is too narrow for all of that, Shared
 * Work is the one that narrows, because it is the panel a person opened for
 * one task and the conversation is the one they live in.
 *
 * These numbers are mirrored by custom properties in desktop.css - each one
 * is named in a comment there - because the browser has to lay out before
 * any script of ours runs and a first paint at the wrong widths is the
 * flicker this whole pass is about. The mirror is what the sizes in
 * test/desktop-room-layout.spec.ts measure, so a drift between the two
 * fails there rather than shipping.
 */

/** The narrowest a conversation may be before it stops being readable.
 *  Mirrored by `--chat-min` in desktop.css. */
export const CHAT_MIN_WIDTH_PX = 360

/** And the least of the window's height it may have, with Work and the call
 *  both asking. Mirrored by `--chat-min-height` in desktop.css. */
export const CHAT_MIN_HEIGHT_FRACTION = 0.6

/** Below this a call pane is not worth the column. Mirrored by
 *  `--call-min`. */
export const CALL_MIN_WIDTH_PX = 240

/** Shared Work's own bounds: what it asks for, and the least it will be cut
 *  to before the window is simply too small for three panels. 28rem and
 *  20rem, mirrored by `--work-max` and `--work-min`. */
export const WORK_MAX_PX = 448
export const WORK_MIN_PX = 320

/** The rooms rail, open and collapsed. 13rem and 3.5rem, mirrored by
 *  `--rail-w` in desktop.css and by desktop-projects-rail.ts. */
export const RAIL_WIDTH_PX = 208
export const RAIL_COLLAPSED_PX = 56

/** Everything the room area never gets: the window's own padding on both
 *  sides, and the gap between the rail and the room. */
export const ROOM_GUTTER_PX = 48

/** The share of the room area the conversation asks for when there is
 *  plenty. Mirrored by the `32%` in `--chat-w`. */
export const CHAT_PREFERRED_FRACTION = 0.32

/** CSS `clamp()`, exactly - including that the floor wins outright when it
 *  is above the ceiling, which is how a minimum that cannot be met still
 *  produces a number rather than a negative box. */
function clamp(min: number, value: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/**
 * How wide Shared Work's panel may be, given the window and the rail.
 *
 * It takes what is left after the conversation's floor and the call pane's
 * floor are put aside, and never more than it asked for. This is the "Work
 * gives way first" rule: at every width where all three cannot have what
 * they want, this is the number that comes down.
 */
export function workPanelWidth(windowWidth: number, railWidth = RAIL_WIDTH_PX): number {
  const spare = windowWidth - (railWidth + CHAT_MIN_WIDTH_PX + CALL_MIN_WIDTH_PX + ROOM_GUTTER_PX)
  return clamp(WORK_MIN_PX, spare, WORK_MAX_PX)
}

/** What the room area - rail and Work taken off - has left. */
export function roomAreaWidth(windowWidth: number, options: { work: boolean; railWidth?: number }): number {
  const railWidth = options.railWidth ?? RAIL_WIDTH_PX
  const work = options.work ? workPanelWidth(windowWidth, railWidth) : 0
  return Math.max(0, windowWidth - railWidth - work - ROOM_GUTTER_PX)
}

/** The conversation drawer's width inside a room area of `roomWidth`, while
 *  a call is live and the two sit side by side. The floor first, its
 *  preferred share after. `fraction` is the share to use instead of the
 *  default, for a person who has dragged the divider - see
 *  `chatDividerWidth` below for the draggable version's own, tighter
 *  ceiling, which pays attention to the call pane it shares the row with. */
export function chatDrawerWidth(roomWidth: number, fraction: number = CHAT_PREFERRED_FRACTION): number {
  return clamp(CHAT_MIN_WIDTH_PX, roomWidth * fraction, WORK_MAX_PX)
}

// ---------------------------------------------------------------------------
// The divider between the call and the conversation, dragged by hand. See
// call-focus.ts for the pointer and keyboard handling this feeds; kept here,
// pure, so the clamping is unit-tested without a browser.

/** Where the divider sits, as a fraction of the room it divides, before
 *  anyone has dragged it. A plain fraction rather than the CSS default's
 *  `clamp(20rem, 24vw, 24rem)`, because a fraction is what survives a resize
 *  and a restart; close enough to it that turning the feature on does not
 *  visibly move anything on an ordinary window. */
export const CHAT_DIVIDER_DEFAULT_FRACTION = 0.24

/** How far one press of an arrow key moves the divider, and with Shift held
 *  for a bigger step. */
export const CHAT_DIVIDER_STEP_FRACTION = 0.02
export const CHAT_DIVIDER_STEP_FRACTION_LARGE = 0.08

/** The call pane's own floor beside the divider: enough for a face - see
 *  `CAMERA_MIN_PX` in desktop-layout-fit.ts, which agrees with
 *  `CALL_MIN_WIDTH_PX` above - plus the gap between the two panes. Dragging
 *  the divider all the way over clamps against this rather than leaving the
 *  call pane too narrow to be worth looking at. */
export const CALL_PANE_FLOOR_PX = CALL_MIN_WIDTH_PX + 16

/**
 * The chat pane's width, in px, for a divider at `fraction` of a container
 * `containerWidth` wide. The chat's own floor wins first - an unreadable
 * chat is the complaint this whole feature answers - and the call pane's
 * floor comes off the top of what is left for the chat to grow into, so
 * dragging past either end clamps rather than collapsing either pane.
 */
export function chatDividerWidth(containerWidth: number, fraction: number): number {
  if (containerWidth <= 0) return CHAT_MIN_WIDTH_PX
  const ceiling = Math.max(CHAT_MIN_WIDTH_PX, containerWidth - CALL_PANE_FLOOR_PX)
  return clamp(CHAT_MIN_WIDTH_PX, containerWidth * fraction, ceiling)
}

/** The inverse: the fraction of `containerWidth` that a dragged width of
 *  `widthPx` represents, clamped through the same floors as
 *  `chatDividerWidth` first. This is what gets persisted - a fraction, not
 *  the pixels themselves - so a stored split scales with the window on the
 *  next visit rather than being applied blindly. */
export function chatDividerFraction(containerWidth: number, widthPx: number): number {
  if (containerWidth <= 0) return CHAT_DIVIDER_DEFAULT_FRACTION
  return chatDividerWidth(containerWidth, widthPx / containerWidth) / containerWidth
}

/**
 * The conversation's width when it is the main column - nothing showing
 * beside it - inside a room area of `roomWidth`.
 *
 * Use the available room width. Individual messages have their own reading
 * width limit; the scroll area and composer must resize with the window.
 */
export function chatColumnWidth(roomWidth: number): number {
  return Math.max(0, roomWidth)
}

/** Whether the conversation is a drawer at the side or the main column.
 *  A drawer only while the call pane is genuinely showing something - see
 *  `callPaneLive` in call-stance.ts. Shared Work is not "beside" it: Work
 *  is a panel outside the room area, and its opening narrows the room
 *  rather than putting anything in it. */
export function chatIsDrawer(callPaneLive: boolean): boolean {
  return callPaneLive
}

/** What is left for the call pane beside it. Allowed to fall below its own
 *  floor rather than take the conversation below the conversation's: a
 *  cramped call pane is a nuisance, an unreadable chat is the complaint. */
export function callPaneWidth(roomWidth: number): number {
  return Math.max(0, roomWidth - chatDrawerWidth(roomWidth))
}
