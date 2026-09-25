/**
 * Call keyboard shortcuts.
 *
 * Control/Command+D toggles the microphone and Control/Command+E toggles
 * the camera, live only while this device is on a call. Holding Space
 * unmutes for as long as it is held down, muting again on release or if the
 * window loses focus while it is held - a push to talk for a call left
 * muted.
 *
 * The two modifier chords work with focus anywhere, including a text
 * field: the modifier is what makes them safe to type around. Space is not
 * - typing a message must still produce spaces - so it is live only
 * outside an input, textarea or contenteditable element.
 *
 * Routed through the same toggleMic/toggleCamera `main.ts` gives the
 * buttons, via the hooks below, so a shortcut leaves state, the UI and
 * what the room is told exactly where a click would.
 */

interface ClosestTarget {
  closest(selector: string): unknown
}

function hasClosest(target: unknown): target is ClosestTarget {
  return typeof target === 'object' && target !== null && typeof (target as ClosestTarget).closest === 'function'
}

const TEXT_ENTRY_SELECTOR = 'input, textarea, [contenteditable="true"]'

/** Whether a key's target is somewhere a person is typing text, and so must
 *  keep Space for itself. */
export function isTextEntry(target: unknown): boolean {
  return hasClosest(target) && Boolean(target.closest(TEXT_ENTRY_SELECTOR))
}

/** Anything Space already means something on: pressing a button, ticking a
 *  box, opening a summary, or a focusable message in the log. Push to talk
 *  must not take Space from a keyboard user sitting on one of these, or a
 *  muted person pressing "Leave" would unmute instead. */
const SPACE_OWNER_SELECTOR = `${TEXT_ENTRY_SELECTOR}, button, a[href], summary, select, [role], [tabindex]`

export function spaceBelongsToTarget(target: unknown): boolean {
  return hasClosest(target) && Boolean(target.closest(SPACE_OWNER_SELECTOR))
}

interface ModifierEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

function isModifierChord(event: ModifierEventLike, key: string): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === key
}

/** Control/Command + D, whatever else has focus. */
export function isMicShortcut(event: ModifierEventLike): boolean {
  return isModifierChord(event, 'd')
}

/** Control/Command + E, whatever else has focus. */
export function isCameraShortcut(event: ModifierEventLike): boolean {
  return isModifierChord(event, 'e')
}

/** Plain Space, held with no modifier. Whether it is live still depends on
 *  where the focus is - see `isTextEntry`. */
export function isPushToTalkKey(event: ModifierEventLike): boolean {
  return event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
}

/** The Mac reads ⌘; everywhere else reads Ctrl. Used for the on-screen
 *  hints - `aria-keyshortcuts` itself always names both, machine-readable. */
export function modifierGlyph(platform: string): string {
  return /mac/i.test(platform) ? '⌘' : 'Ctrl'
}

export interface CallShortcutHooks {
  /** Whether this device is presently on the call. */
  onCall(): boolean
  /** Toggle the microphone exactly as the mic button does. */
  toggleMic(): void
  /** Toggle the camera exactly as the camera button does. */
  toggleCamera(): void
  /** True when the microphone is off or muted - what push to talk unmutes,
   *  and what it must find true again before it will re-engage. */
  micMuted(): boolean
}

/** Wires the shortcuts onto `root` (for keydown/keyup) and `windowLike`
 *  (for the blur that ends a held Space). Call once; the hooks are read
 *  fresh on every key, so call state, mute state and the toggle functions
 *  themselves may change under it between calls. */
export function installCallShortcuts(
  root: Pick<Document, 'addEventListener'>,
  windowLike: Pick<Window, 'addEventListener'>,
  hooks: CallShortcutHooks,
): void {
  // Only true while Space itself put the microphone on: releasing it must
  // never mute a microphone the person unmuted some other way in between.
  let holdingSpace = false

  const releaseSpace = (): void => {
    if (!holdingSpace) return
    holdingSpace = false
    hooks.toggleMic()
  }

  root.addEventListener('keydown', (event) => {
    const ev = event as KeyboardEvent
    if (ev.defaultPrevented || ev.isComposing || !hooks.onCall()) return
    if (isMicShortcut(ev)) { ev.preventDefault(); hooks.toggleMic(); return }
    if (isCameraShortcut(ev)) { ev.preventDefault(); hooks.toggleCamera(); return }
    if (!isPushToTalkKey(ev) || spaceBelongsToTarget(ev.target)) return
    // Browser key repeat resends keydown every ~30ms while held; the guard
    // below is what stops that from toggling the microphone over and over.
    if (ev.repeat || holdingSpace) return
    if (!hooks.micMuted()) return
    ev.preventDefault()
    holdingSpace = true
    hooks.toggleMic()
  })

  root.addEventListener('keyup', (event) => {
    if (isPushToTalkKey(event as KeyboardEvent)) releaseSpace()
  })

  // A held key generates no keyup at all if the window loses focus first -
  // Alt-Tab away, a native file picker, a devtools panel taking the key.
  // Without this the microphone would stay open until Space is pressed
  // again, unmuted, in a window the room can no longer see.
  windowLike.addEventListener('blur', releaseSpace)
}
