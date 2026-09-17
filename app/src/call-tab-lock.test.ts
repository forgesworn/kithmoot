import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallTabLock, type CallTabLockHandlers } from './call-tab-lock.js'

const KEY = `${'a'.repeat(64)}|${'b'.repeat(64)}`
const OTHER_KEY = `${'a'.repeat(64)}|${'c'.repeat(64)}`
const open: CallTabLock[] = []
afterEach(() => { for (const lock of open.splice(0)) lock.close() })

function handlers(): CallTabLockHandlers & { preempted: string[]; heldElsewhere: string[]; freed: string[] } {
  const preempted: string[] = []
  const heldElsewhere: string[] = []
  const freed: string[] = []
  return {
    preempted,
    heldElsewhere,
    freed,
    onPreempted: (key) => preempted.push(key),
    onHeldElsewhere: (key) => heldElsewhere.push(key),
    onFreed: (key) => freed.push(key),
  }
}

function lock(h: CallTabLockHandlers = handlers()) {
  const l = new CallTabLock(h, new BroadcastChannel('kithmoot.call-tab-lock.test'))
  open.push(l)
  return l
}

describe('CallTabLock', () => {
  it('a tab with nothing claimed learns nobody else holds the key', async () => {
    const me = lock()
    lock()
    expect(await me.askHeldElsewhere(KEY, 50)).toBe(false)
  })

  it('a tab that already claimed a key answers a later probe', async () => {
    const holder = lock()
    holder.claim(KEY)
    const me = lock()
    expect(await me.askHeldElsewhere(KEY, 100)).toBe(true)
    // A different key held by nobody is unaffected.
    expect(await me.askHeldElsewhere(OTHER_KEY, 50)).toBe(false)
  })

  it('claiming a key another tab holds preempts it, and only it', async () => {
    const h = handlers()
    const first = lock(h)
    first.claim(KEY)
    const h2 = handlers()
    lock(h2).claim(KEY)
    await vi.waitFor(() => expect(h.preempted).toEqual([KEY]))
    expect(h.heldElsewhere).toEqual([])
    // The claimant is not told anything about its own claim.
    expect(h2.preempted).toEqual([])
    expect(h2.heldElsewhere).toEqual([])
  })

  it('a tab that never held the key is told it is held elsewhere, not preempted', async () => {
    const h = handlers()
    lock(h)
    lock().claim(KEY)
    await vi.waitFor(() => expect(h.heldElsewhere).toEqual([KEY]))
    expect(h.preempted).toEqual([])
  })

  it('releasing tells every other tab the key is free', async () => {
    const holder = lock()
    holder.claim(KEY)
    const h = handlers()
    lock(h)
    holder.release(KEY)
    await vi.waitFor(() => expect(h.freed).toEqual([KEY]))
  })

  it('releasing a key never claimed sends nothing', async () => {
    const h = handlers()
    lock(h)
    const idle = lock()
    idle.release(KEY)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.freed).toEqual([])
  })

  it('taking a key back after being preempted claims it again', async () => {
    const original = handlers()
    const first = lock(original)
    first.claim(KEY)
    const second = handlers()
    const claimant = lock(second)
    claimant.claim(KEY)
    await vi.waitFor(() => expect(original.preempted).toEqual([KEY]))
    // First takes it back.
    first.claim(KEY)
    await vi.waitFor(() => expect(second.preempted).toEqual([KEY]))
  })
})
