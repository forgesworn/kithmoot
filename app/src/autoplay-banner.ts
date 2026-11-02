/**
 * Whether a blocked `play()` on a remote audio element deserves the "tap to
 * hear" banner - the decision only, so it can be tested without a document.
 *
 * A person who never gestured at the page - the update-and-rejoin path in
 * main.ts is the one that matters, but any future one counts too - gets
 * remote video that plays (muted, so the autoplay policy allows it) and
 * remote audio that silently does not. `NotAllowedError` is Chromium and
 * Firefox's name for the rejection; Safari has used the same name for
 * years, so no separate case is carried for it.
 *
 * Shown for every such rejection, gesture or not (1 November 2026). Safari
 * refuses sound outside a fresh tap even after earlier clicks when the
 * microphone is off, and hiding the banner then left people in a call
 * hearing nothing with nothing to press. A tap that does not help costs
 * one tap; silence costs the call.
 */
export function isAutoplayBlock(error: unknown, _activation?: UserActivation): boolean {
  const name = error instanceof DOMException ? error.name
    : typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name)
    : undefined
  return name === 'NotAllowedError'
}

/**
 * Whether the banner should show at all, given the wider call state.
 *
 * `inRoom` is not "this device has pressed Join call" - a person who has
 * just walked into a room where a call is already on sees and hears it
 * before pressing anything, and is exactly who this banner is for. It is
 * false only once this device has left the room entirely. Never shown for
 * a person who has pressed Leave, or whose remote audio is deliberately
 * muted for some other reason, whatever the browser is doing to it.
 */
export function shouldShowAutoplayBanner(deps: { inRoom: boolean; audioDeliberatelyMuted: boolean }): boolean {
  return deps.inRoom && !deps.audioDeliberatelyMuted
}

/**
 * Tracks whether the "tap to hear" banner should be on screen.
 *
 * One rejection is enough to show it; one tap resumes everything blocked
 * and hides it; a later rejection - a new track arriving after the tap,
 * say - shows it again. Deliberately dumb about *why* playback resumed:
 * the caller's tap handler either succeeds, in which case it calls
 * `resumed()` itself, or it does not, in which case the next `blocked()`
 * call puts the banner straight back.
 */
export class AutoplayBannerState {
  #visible = false

  /** Call whenever a remote audio element's `play()` rejects. Returns
   *  whether the banner should now be shown - a caller with no state of its
   *  own can just render on the return value. */
  blocked(error: unknown, deps: { inRoom: boolean; audioDeliberatelyMuted: boolean }, activation?: UserActivation): boolean {
    if (isAutoplayBlock(error, activation) && shouldShowAutoplayBanner(deps)) this.#visible = true
    return this.#visible
  }

  /** Call once every paused element has been resumed. */
  resumed(): void {
    this.#visible = false
  }

  /** Call when leaving the call, or when remote audio is deliberately
   *  muted: the banner is never right to show under either. */
  hide(): void {
    this.#visible = false
  }

  get visible(): boolean {
    return this.#visible
  }
}
