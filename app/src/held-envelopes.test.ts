import { describe, expect, it, vi } from 'vitest'
import { HeldEnvelopes } from './held-envelopes.js'

const H1 = 'a1'.repeat(32), H2 = 'b2'.repeat(32), H3 = 'c3'.repeat(32)
const entry = (roomId = 'room', dispose = vi.fn()) => ({ roomId, envelope: new Blob(['sealed']), reason: 'no-grant' as const, dispose })

describe('sealed files waiting for the group’s storage', () => {
  it('are held under their hash, in memory, until released, and freed once', async () => {
    const held = new HeldEnvelopes()
    const a = entry()
    await held.hold(H1, a)
    expect(held.has(H1)).toBe(true)
    expect(held.has(H1.toUpperCase())).toBe(true)
    expect(held.get(H1)?.reason).toBe('no-grant')
    expect(held.size).toBe(1)
    await held.release(H1)
    await held.release(H1)
    expect(held.has(H1)).toBe(false)
    expect(a.dispose).toHaveBeenCalledTimes(1)
  })

  it('a file already held keeps its place, and the copy offered again is freed', async () => {
    const held = new HeldEnvelopes()
    const first = entry(), again = entry()
    await held.hold(H1, first)
    await held.hold(H1, again)
    expect(held.get(H1)?.dispose).toBe(first.dispose)
    expect(first.dispose).not.toHaveBeenCalled()
    expect(again.dispose).toHaveBeenCalledTimes(1)
  })

  it('a file is kept while a draft still has it, or while its message can still go, and freed when neither is so', async () => {
    const held = new HeldEnvelopes()
    const inDraft = entry(), inMessage = entry(), moved = entry(), orphan = entry()
    await held.hold(H1, inDraft)
    await held.hold(H2, inMessage)
    await held.hold(H3, moved)
    await held.hold('d4'.repeat(32), orphan)
    held.attach([H2], 'message-1')
    held.attach([H3], 'message-2')
    // message-2 has moved to another key, so it is not among the live messages.
    await held.sweep({ draftHashes: new Set([H1]), messageIds: new Set(['message-1']) })
    expect(held.has(H1)).toBe(true)
    expect(held.has(H2)).toBe(true)
    expect(held.has(H3)).toBe(false)
    expect(held.has('d4'.repeat(32))).toBe(false)
    expect(inDraft.dispose).not.toHaveBeenCalled()
    expect(inMessage.dispose).not.toHaveBeenCalled()
    expect(moved.dispose).toHaveBeenCalledTimes(1)
    expect(orphan.dispose).toHaveBeenCalledTimes(1)
  })

  it('a message that was deleted frees its files, unless a draft took them back', async () => {
    const held = new HeldEnvelopes()
    const a = entry(), b = entry()
    await held.hold(H1, a)
    await held.hold(H2, b)
    held.attach([H1, H2], 'message-1')
    await held.sweep({ draftHashes: new Set([H2]), messageIds: new Set() })
    expect(held.has(H1)).toBe(false)
    expect(held.has(H2)).toBe(true)
    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(b.dispose).not.toHaveBeenCalled()
  })

  it('leaving a room frees its files and no other room’s', async () => {
    const held = new HeldEnvelopes()
    const here = entry('here'), there = entry('there')
    await held.hold(H1, here)
    await held.hold(H2, there)
    await held.clear('here')
    expect(held.has(H1)).toBe(false)
    expect(held.has(H2)).toBe(true)
    await held.clear()
    expect(held.size).toBe(0)
    expect(there.dispose).toHaveBeenCalledTimes(1)
  })

  it('a backing file that will not go does not keep the bytes or stop the sweep', async () => {
    const held = new HeldEnvelopes()
    const stuck = entry('room', vi.fn(() => { throw new Error('locked') }))
    await held.hold(H1, stuck)
    await expect(held.release(H1)).resolves.toBeUndefined()
    expect(held.size).toBe(0)
  })
})
