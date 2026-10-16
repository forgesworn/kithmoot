/**
 * Letting somebody in through a temporary link without every device saying so.
 *
 * With "Ask me before letting people in" off, every device holding the
 * link's authority answers a request on its own. Each used to answer the
 * instant the request arrived, under its own responder key, so anybody who
 * held the link could post a request and count the grants: how many member
 * devices were online, which of them were awake, and how quickly each one
 * was - the silent-receipt side channel of the "Careless Whisper" study,
 * worked through the door instead of the chat.
 *
 * This is the app half of the repair. One device answers, after a random
 * wait, and the rest stand down when they see its answer:
 *
 * - The room's creator holds the inviter key itself, so a grant it signs is
 *   checkable by everybody: its `pubkey` is the link's pinned inviter. It
 *   answers first, after `CREATOR_GRANT_DELAY_MS`.
 * - Every other member device waits longer, `MEMBER_GRANT_DELAY_MS`, so
 *   that when the creator is here its answer has had time to arrive, and
 *   the members' own waits are spread so the first of them is usually the
 *   only one.
 * - Any answer to the same requester seen during the wait stands this device
 *   down. One signed by the inviter is final. One signed by anybody else
 *   cannot be checked - a grant is encrypted to the requester, and its
 *   delegation chain with it - so a stranger could post one to silence the
 *   room. For those this device keeps listening: the requester re-sends the
 *   same request every two seconds until a grant it can open arrives, so a
 *   request still being asked `STAND_DOWN_SETTLE_MS` after the other answer
 *   says the other answer did not let them in, and this device answers after
 *   all. That is the member-epoch desk's "stand down once" rule, adapted to
 *   a requester that does not mint a fresh request per round.
 *
 * Knock on is untouched: a person deciding is already a random delay, and
 * the card is theirs to answer.
 */

/** The creator's wait before an automatic grant. Random so a request's
 *  round trip says nothing about the device, and short because a person is
 *  standing at the door. */
export const CREATOR_GRANT_DELAY_MS: readonly [number, number] = [500, 2_000]

/**
 * Every other member device's wait. It starts after the creator's longest
 * wait plus a relay's fan-out, so a creator who is here has always answered
 * first; it is spread over three and a half seconds so that two members
 * rarely answer inside each other's propagation delay.
 */
export const MEMBER_GRANT_DELAY_MS: readonly [number, number] = [2_500, 6_000]

/**
 * How long after an unverifiable answer before the requester still asking
 * counts as evidence it did not get in. The requester re-sends every 2s
 * (fold-kit's `DEFAULT_RETRY_MS`), and a real grant reaches it in well under
 * a second, so a re-send this long after the other answer is a re-send the
 * answer did not stop.
 */
export const STAND_DOWN_SETTLE_MS = 3_000

/** How long a stood-down device keeps listening for that evidence. Past it,
 *  the requester has either been let in or given up. */
export const STAND_DOWN_LISTEN_MS = 15_000

/**
 * The longest the whole decision may take, however many answers arrive. A
 * stranger posting a junk grant every few seconds would otherwise keep this
 * device standing down, and its subscriptions open, for as long as the room
 * is. Comfortably inside the request's own 90 second life.
 */
export const QUIET_ADMISSION_DEADLINE_MS = 60_000

/** Ignore a re-send this soon after subscribing unless the relays have said
 *  they are done replaying: a relay that keeps ephemeral requests hands the
 *  old one back at once, and that is not the requester asking again. */
const REPLAY_GRACE_MS = 1_000

export interface AnswerSeen {
  /** Signed by the link's pinned inviter, and the signature checked. */
  verifiedCreator: boolean
}

export interface QuietAdmissionDeps {
  /** This device holds the inviter key itself (no delegation chain). */
  creator: boolean
  /** Watch for any grant or refusal addressed to this requester. */
  watchAnswers(onAnswer: (answer: AnswerSeen) => void): () => void
  /** Watch for this request being sent again. `onEose` once the relays
   *  have replayed what they hold. */
  watchRetries(onRetry: () => void, onEose: () => void): () => void
  /** Stops the wait and declines: the room was left, the link changed. */
  signal?: AbortSignal
  random?: () => number
  setTimer?: (ms: number, run: () => void) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

function within([low, high]: readonly [number, number], random: () => number): number {
  return low + Math.floor(random() * (high - low + 1))
}

/**
 * Whether this device should grant an automatic admission, decided quietly.
 * Resolves true to grant, false to stand down. Never rejects.
 */
export function quietAutoAdmit(deps: QuietAdmissionDeps): Promise<boolean> {
  const random = deps.random ?? Math.random
  const setTimer = deps.setTimer ?? ((ms, run) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const now = deps.now ?? (() => Date.now())

  return new Promise<boolean>((resolve) => {
    let settled = false
    const timers = new Set<unknown>()
    let deadline: unknown
    let offAnswers: () => void = () => {}
    let offRetries: () => void = () => {}
    const finish = (grant: boolean): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimer(timer)
      timers.clear()
      if (deadline !== undefined) clearTimer(deadline)
      try { offAnswers() } catch { /* Unsubscribing cannot change the answer. */ }
      try { offRetries() } catch { /* As above. */ }
      deps.signal?.removeEventListener('abort', abort)
      resolve(grant)
    }
    const abort = (): void => finish(false)
    const after = (ms: number, run: () => void): void => {
      const timer = setTimer(ms, () => {
        timers.delete(timer)
        if (!settled) run()
      })
      timers.add(timer)
    }

    if (deps.signal?.aborted) { finish(false); return }
    deps.signal?.addEventListener('abort', abort, { once: true })
    // Outside `timers`, so standing down again never clears it.
    deadline = setTimer(QUIET_ADMISSION_DEADLINE_MS, () => finish(false))

    /** 'waiting' for its own turn; 'stood-down' after another answer;
     *  'retrying' once the requester was seen still asking. */
    let state: 'waiting' | 'stood-down' | 'retrying' = 'waiting'
    const clearAll = (): void => {
      for (const timer of timers) clearTimer(timer)
      timers.clear()
      try { offRetries() } catch { /* Unsubscribing cannot change the answer. */ }
      offRetries = () => {}
    }
    const listenForRetry = (): void => {
      const openedAt = now()
      let replayed = false
      offRetries = deps.watchRetries(() => {
        if (settled || state !== 'stood-down') return
        if (!replayed && now() - openedAt < REPLAY_GRACE_MS) return
        // Still asking: whatever the other answer was, it did not let them in.
        state = 'retrying'
        after(within(CREATOR_GRANT_DELAY_MS, random), () => finish(true))
      }, () => { replayed = true })
      after(STAND_DOWN_LISTEN_MS, () => finish(false))
    }
    const standDown = (): void => {
      state = 'stood-down'
      clearAll()
      after(STAND_DOWN_SETTLE_MS, listenForRetry)
    }

    offAnswers = deps.watchAnswers((answer) => {
      if (settled) return
      if (answer.verifiedCreator) { finish(false); return }
      // A second unverifiable answer while already standing down changes
      // nothing; one that lands while this device was about to answer after
      // all starts the wait again, because it may be the real one.
      if (state === 'stood-down') return
      standDown()
    })
    if (settled) return

    after(within(deps.creator ? CREATOR_GRANT_DELAY_MS : MEMBER_GRANT_DELAY_MS, random), () => finish(true))
  })
}
