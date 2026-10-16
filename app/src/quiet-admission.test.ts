import { describe, expect, it } from 'vitest'
import {
  CREATOR_GRANT_DELAY_MS,
  MEMBER_GRANT_DELAY_MS,
  STAND_DOWN_LISTEN_MS,
  STAND_DOWN_SETTLE_MS,
  quietAutoAdmit,
  type AnswerSeen,
} from './quiet-admission.js'

class Clock {
  t = 0
  #next = 1
  readonly timers = new Map<number, { at: number; run: () => void }>()
  setTimer = (ms: number, run: () => void): unknown => {
    const id = this.#next++
    this.timers.set(id, { at: this.t + ms, run })
    return id
  }
  clearTimer = (handle: unknown): void => { this.timers.delete(handle as number) }
  now = (): number => this.t
  advance(ms: number): void {
    const until = this.t + ms
    for (;;) {
      let due: [number, { at: number; run: () => void }] | undefined
      for (const entry of this.timers) if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry
      if (!due) break
      this.timers.delete(due[0])
      this.t = due[1].at
      due[1].run()
    }
    this.t = until
  }
}

function setup(creator: boolean, random = 0.5) {
  const clock = new Clock()
  let answer: ((a: AnswerSeen) => void) | undefined
  let retry: (() => void) | undefined
  let eose: (() => void) | undefined
  let answersOpen = 0
  let retriesOpen = 0
  let outcome: boolean | undefined
  const controller = new AbortController()
  void quietAutoAdmit({
    creator,
    random: () => random,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    signal: controller.signal,
    watchAnswers: (cb) => { answer = cb; answersOpen++; return () => { answersOpen-- } },
    watchRetries: (cb, onEose) => { retry = cb; eose = onEose; retriesOpen++; return () => { retriesOpen-- } },
  }).then((yes) => { outcome = yes })
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return {
    clock, controller, flush,
    answer: (a: AnswerSeen) => answer!(a),
    retry: () => retry!(),
    eose: () => eose!(),
    get outcome() { return outcome },
    get open() { return { answers: answersOpen, retries: retriesOpen } },
  }
}

describe('quietAutoAdmit', () => {
  it('has the creator grant after a random 0.5 to 2 seconds, never at once', async () => {
    for (const [random, at] of [[0, CREATOR_GRANT_DELAY_MS[0]], [0.9999, CREATOR_GRANT_DELAY_MS[1]]] as const) {
      const run = setup(true, random)
      run.clock.advance(at - 1)
      await run.flush()
      expect(run.outcome).toBeUndefined()
      run.clock.advance(1)
      await run.flush()
      expect(run.outcome).toBe(true)
      expect(run.open).toEqual({ answers: 0, retries: 0 })
    }
    expect(CREATOR_GRANT_DELAY_MS).toEqual([500, 2_000])
  })

  it('has other members wait until after the creator has had its turn', async () => {
    expect(MEMBER_GRANT_DELAY_MS[0]).toBeGreaterThan(CREATOR_GRANT_DELAY_MS[1])
    const run = setup(false, 0)
    run.clock.advance(MEMBER_GRANT_DELAY_MS[0] - 1)
    await run.flush()
    expect(run.outcome).toBeUndefined()
    run.clock.advance(1)
    await run.flush()
    expect(run.outcome).toBe(true)
  })

  it('stands down for good when the creator answers first', async () => {
    const run = setup(false)
    run.clock.advance(1_000)
    run.answer({ verifiedCreator: true })
    await run.flush()
    expect(run.outcome).toBe(false)
    expect(run.open).toEqual({ answers: 0, retries: 0 })
  })

  it('stays silent after another member answers and the requester stops asking', async () => {
    const run = setup(false)
    run.clock.advance(1_000)
    run.answer({ verifiedCreator: false })
    run.clock.advance(MEMBER_GRANT_DELAY_MS[1])
    await run.flush()
    expect(run.outcome).toBeUndefined()
    run.eose()
    run.clock.advance(STAND_DOWN_LISTEN_MS)
    await run.flush()
    expect(run.outcome).toBe(false)
    expect(run.open).toEqual({ answers: 0, retries: 0 })
  })

  it('answers after all when the requester is still asking after an answer it could not open', async () => {
    const run = setup(false, 0)
    run.clock.advance(100)
    run.answer({ verifiedCreator: false })
    run.clock.advance(STAND_DOWN_SETTLE_MS)
    // A relay replaying what it kept is not the requester asking again.
    run.retry()
    run.clock.advance(CREATOR_GRANT_DELAY_MS[1])
    await run.flush()
    expect(run.outcome).toBeUndefined()
    run.eose()
    run.retry()
    run.clock.advance(CREATOR_GRANT_DELAY_MS[0])
    await run.flush()
    expect(run.outcome).toBe(true)
  })

  it('goes back to standing down if a fresh answer lands while it was about to answer', async () => {
    const run = setup(false, 0)
    run.answer({ verifiedCreator: false })
    run.clock.advance(STAND_DOWN_SETTLE_MS)
    run.eose()
    run.retry()
    run.answer({ verifiedCreator: false })
    run.clock.advance(CREATOR_GRANT_DELAY_MS[1])
    await run.flush()
    expect(run.outcome).toBeUndefined()
    run.clock.advance(STAND_DOWN_SETTLE_MS + STAND_DOWN_LISTEN_MS)
    await run.flush()
    expect(run.outcome).toBe(false)
  })

  it('declines when the wait is abandoned', async () => {
    const run = setup(true)
    run.controller.abort()
    await run.flush()
    expect(run.outcome).toBe(false)
    expect(run.clock.timers.size).toBe(0)
  })
})
