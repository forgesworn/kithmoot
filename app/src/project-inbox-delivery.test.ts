import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { deliverGuardedProjectInbox } from './project-inbox-delivery.js'

const wrap = finalizeEvent({ kind: 1059, created_at: 1, tags: [], content: 'synthetic encrypted payload' }, generateSecretKey())
const recipient = 'ab'.repeat(32)

describe('guarded project inbox delivery', () => {
  it('does not look up or open relays for a removed recipient', async () => {
    const targets = vi.fn(), pool = vi.fn()
    await deliverGuardedProjectInbox(wrap, recipient, () => false, { targets, pool })
    expect(targets).not.toHaveBeenCalled(); expect(pool).not.toHaveBeenCalled()
  })
  it('does not open a pool after membership changes during recipient lookup', async () => {
    let allowed = true, resolve!: (targets: string[]) => void
    const targets = vi.fn(() => new Promise<string[]>(done => { resolve = done })), pool = vi.fn()
    const pending = deliverGuardedProjectInbox(wrap, recipient, () => allowed, { targets, pool })
    allowed = false; resolve(['wss://recipient.invalid']); await pending
    expect(pool).not.toHaveBeenCalled()
  })
  it('keeps checking membership before delayed socket writes and closes the pool', async () => {
    let allowed = true, ready!: () => void, checked!: () => void
    const gate = new Promise<void>(done => { ready = done }), entered = new Promise<void>(done => { checked = done })
    const writes: string[] = [], close = vi.fn()
    const publishGuarded = vi.fn(async (event, current: () => boolean) => {
      checked(); await gate
      if (current()) writes.push(event.id)
    })
    const pending = deliverGuardedProjectInbox(wrap, recipient, () => allowed, {
      targets: async () => ['wss://recipient.invalid'], pool: () => ({ publishGuarded, close }),
    })
    await entered; allowed = false; ready(); await pending
    expect(writes).toEqual([]); expect(close).toHaveBeenCalledOnce()
  })
  it('closes a failed connection and refuses an unguarded carrier', async () => {
    const close = vi.fn()
    await expect(deliverGuardedProjectInbox(wrap, recipient, () => true, {
      targets: async () => ['wss://recipient.invalid'], pool: () => ({ close }),
    })).rejects.toThrow('cannot safely deliver')
    expect(close).toHaveBeenCalledOnce()
  })
})
