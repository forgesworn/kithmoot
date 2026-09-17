/**
 * Whether a blocked `play()` on a remote audio element deserves the "tap to
 * hear" banner - the decision only, so it can be tested without a document.
 *
 * A person who never gestured at the page - the update-and-rejoin path in
 * main.ts is the one that matters, but any future one counts too - gets
 * remote video that plays (muted, so the autoplay policy allows it) and
 * remote audio that silently does not. `NotAllowedError` is Chromium and
 * Firefox's name for the rejection; Safari has used the same name for
 * years, so no separate case is carried for it. `navigator.userActivation`,
 * where a browser has it, adds the second half of the check the error name
 * alone cannot: a `NotAllowedError` after this page really has seen a
 * gesture is some other permission problem, and the fix a fresh tap offers
 * cannot be trusted to work, so it is only ever shown for a rejection this
 * page's own history explains.
 */
export function isAutoplayBlock(error: unknown, activation?: UserActivation): boolean {
  const name = error instanceof DOMException ? error.name
    : typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name)
    : undefined
  if (name !== 'NotAllowedError') return false
  if (!activation) return true
  return !activation.hasBeenActive
}

/**
 * Whether the banner should show at all, given the wider call state - never
 * for a person who is off the call with remote audio deliberately muted for
 * that reason, whatever the browser is doing to it.
 */
export function shouldShowAutoplayBanner(deps: { onCall: boolean; audioDeliberatelyMuted: boolean }): boolean {
  return deps.onCall && !deps.audioDeliberatelyMuted
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
  blocked(error: unknown, deps: { onCall: boolean; audioDeliberatelyMuted: boolean }, activation?: UserActivation): boolean {
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
