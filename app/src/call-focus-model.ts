/**
 * The call first, on a wide screen: the decisions behind it, kept apart from
 * the DOM so they can be tested without a browser. `call-focus.ts` does the
 * wiring.
 *
 * While this device is on a call with pictures in it, the call stage takes
 * the room area at full height, its controls become one bar along the
 * bottom of the stage, and the conversation is a side panel that the bar
 * opens and closes. Phones and short landscape windows keep their own
 * layout (`#roomArea[data-mobile-view]` in style.css), and so does a voice
 * call with nothing to look at, which stays the strip the installed window
 * already makes of it (`data-call-pane="controls"` in desktop.css).
 */

/** Narrower than this and the stage and a chat panel cannot both be worth
 *  having; the room falls back to its stacked layout. */
export const CALL_FIRST_MIN_WIDTH = 900
/** Matches `DESKTOP_STAGE` in call-stage.ts: below it the call stage itself
 *  does not run, and the short-landscape phone layout takes over. */
export const CALL_FIRST_MIN_HEIGHT = 541
/** At this width and wider the chat panel starts open, unless this device
 *  has said otherwise. */
export const CHAT_OPEN_MIN_WIDTH = 1280

export interface CallFirstInput {
  width: number
  height: number
  /** This device is on a call, in the room on screen. */
  onCall: boolean
  /** The call is docked: another room is on screen and the call is out of
   *  sight. See `DockedCall` in main.ts. */
  docked: boolean
  /** What the call pane is showing: `live` when there is a picture to show,
   *  `controls` for a voice call, `resting` for no call. See `CallPane`. */
  pane: string | undefined
}

/** Whether the room is laid out call first. */
export function callFirst(input: CallFirstInput): boolean {
  return input.onCall
    && !input.docked
    && input.pane === 'live'
    && input.width >= CALL_FIRST_MIN_WIDTH
    && input.height >= CALL_FIRST_MIN_HEIGHT
}

// ---------------------------------------------------------------------------
// Whether the chat panel is open, remembered on this device.

export const CHAT_PANEL_KEY = 'kithmoot.call-chat-panel'

/** What this device last left the panel as, or undefined when it never
 *  said. Any storage failure reads as never said. */
export function loadChatPanel(storage: Pick<Storage, 'getItem'>): boolean | undefined {
  try {
    const raw = storage.getItem(CHAT_PANEL_KEY)
    if (raw === 'open') return true
    if (raw === 'closed') return false
  } catch {
    // Fall through.
  }
  return undefined
}

export function saveChatPanel(storage: Pick<Storage, 'setItem'>, open: boolean): void {
  try {
    storage.setItem(CHAT_PANEL_KEY, open ? 'open' : 'closed')
  } catch {
    // The toggle still works for the rest of this visit.
  }
}

/** Open or closed: this device's own answer if it gave one, otherwise open
 *  on a window wide enough for the stage and the panel together. */
export function chatPanelOpen(remembered: boolean | undefined, width: number): boolean {
  return remembered ?? width >= CHAT_OPEN_MIN_WIDTH
}

// ---------------------------------------------------------------------------
// The divider between the call and the conversation, remembered on this
// device as a fraction of the room it divides - see `chatDividerWidth` and
// `chatDividerFraction` in desktop-panes.ts for the arithmetic a fraction
// turns into a width.

export const CHAT_DIVIDER_KEY = 'kithmoot.call-chat-divider'

/** The fraction this device last dragged the divider to, or undefined when
 *  it never has - a fresh visit, one that reset it, or any storage failure
 *  all read the same way: let the default apply. */
export function loadChatDividerFraction(storage: Pick<Storage, 'getItem'>): number | undefined {
  try {
    const raw = storage.getItem(CHAT_DIVIDER_KEY)
    if (raw === null) return undefined
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 && value < 1 ? value : undefined
  } catch {
    return undefined
  }
}

export function saveChatDividerFraction(storage: Pick<Storage, 'setItem'>, fraction: number): void {
  try {
    storage.setItem(CHAT_DIVIDER_KEY, String(fraction))
  } catch {
    // The divider still works for the rest of this visit.
  }
}

/** Forgets the dragged split, so the divider goes back to the default. */
export function clearChatDividerFraction(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(CHAT_DIVIDER_KEY)
  } catch {
    // Nothing to do: the default still applies for the rest of this visit.
  }
}

// ---------------------------------------------------------------------------
// Messages that arrived while the panel was shut.

/**
 * Counts messages from other people that arrived while the chat panel was
 * closed. The first set of messages it sees in a conversation is what was
 * already there, never news; after that, an id it has not seen before,
 * seen while the panel is closed, is one more unread. Opening the panel
 * reads them all.
 */
export class UnreadCounter {
  #scope: string | undefined
  #seen = new Set<string>()
  #current: readonly string[] = []
  #count = 0
  #agents = 0

  get count(): number { return this.#count }
  /** Of `count`, how many are an agent's message that reached this person -
   *  see `classifyMessage` in `src/messages.ts` - rather than a person's
   *  own. Always at most `count`. */
  get agents(): number { return this.#agents }

  /** The messages from other people now in the conversation `scope`, and
   *  whether the panel showing them is open. `agentIds` names which of
   *  `ids` are the agent ones, for the `agents` split above; every id not
   *  in it is read as a person's. Returns the unread count. */
  update(scope: string, ids: readonly string[], open: boolean, agentIds: readonly string[] = []): number {
    this.#current = ids
    if (scope !== this.#scope) {
      this.#scope = scope
      this.#seen = new Set(ids)
      this.#count = 0
      this.#agents = 0
      return 0
    }
    if (open) return this.read()
    const agentSet = new Set(agentIds)
    for (const id of ids) {
      if (this.#seen.has(id)) continue
      this.#seen.add(id)
      this.#count++
      if (agentSet.has(id)) this.#agents++
    }
    return this.#count
  }

  /** The panel was opened: everything in it has been seen. */
  read(): number {
    for (const id of this.#current) this.#seen.add(id)
    this.#count = 0
    this.#agents = 0
    return 0
  }

  /** Forget the conversation, so the next update is a new baseline. */
  reset(): void {
    this.#scope = undefined
    this.#seen.clear()
    this.#current = []
    this.#count = 0
    this.#agents = 0
  }
}

/** What the Chat button says to a screen reader about unread messages, or
 *  the empty string when there are none. */
export function unreadAnnouncement(count: number): string {
  if (count <= 0) return ''
  return count === 1 ? '1 new message in the chat' : `${count} new messages in the chat`
}

// ---------------------------------------------------------------------------
// The control bar, from the keyboard.

/** Where an arrow key, Home or End moves focus in a toolbar of `length`
 *  items from `index`, or undefined for any other key. Wraps at the ends,
 *  the way the ARIA toolbar pattern suggests. */
export function toolbarMove(key: string, index: number, length: number): number | undefined {
  if (length <= 0) return undefined
  switch (key) {
    case 'ArrowRight': return (index + 1) % length
    case 'ArrowLeft': return (index - 1 + length) % length
    case 'Home': return 0
    case 'End': return length - 1
    default: return undefined
  }
}
