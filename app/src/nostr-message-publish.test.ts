import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { NostrRelayPool } from '../../src/relay-pool.js'
import { RelayDialGate } from '../../src/relay-dial-gate.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays } from '../../test/fake-socket.js'
import { publishToInboxRelays } from './nostr-message-publish.js'

const Base = FakeWebSocket as unknown as typeof WebSocket
const account = generateSecretKey()
const wrap = () => finalizeEvent({ kind: 1059, created_at: 1_800_000_000, tags: [['p', getPublicKey(generateSecretKey())]], content: 'sealed' }, generateSecretKey())
const gate = new RelayDialGate()

describe('gift wrap delivery to NIP-42 inbox relays', () => {
  let opened: NostrRelayPool[]
  const open = (url: string) => {
    const pool = new NostrRelayPool([{ url, read: false, write: true }], undefined, { websocketImplementation: Base, dialGate: gate })
    opened.push(pool)
    return pool
  }
  beforeEach(() => { resetFakeRelays(); opened = []; vi.useFakeTimers() })
  afterEach(() => { for (const pool of opened) pool.close(); vi.useRealTimers() })
  const run = async (event: ReturnType<typeof wrap>, relays: string[], current = () => true) => {
    const done = publishToInboxRelays(event, relays, current, open)
    const settled = done.then(value => ({ value }), (error: unknown) => ({ error }))
    await vi.advanceTimersByTimeAsync(60_000)
    return settled
  }

  it('authenticates with a throwaway key when a relay refuses until it does', async () => {
    const relay = fakeRelay('wss://auth.inbox.test'); relay.authChallenge = 'c-1'
    const event = wrap()
    const result = await run(event, ['wss://auth.inbox.test'])
    expect(result).toMatchObject({ value: { accepted: ['wss://auth.inbox.test'], unaccepted: [] } })
    expect(relay.stored.map(row => row.id)).toEqual([event.id])
    expect(relay.authenticated).toHaveLength(1)
    expect(relay.authenticated[0]).not.toBe(getPublicKey(account))
  })

  it('offers the event again when the relay closes the link before authentication completes', async () => {
    const relay = fakeRelay('wss://closing.inbox.test'); relay.authChallenge = 'c-2'; relay.dropUnauthenticated = true
    const event = wrap()
    const result = await run(event, ['wss://closing.inbox.test'])
    expect(result).toMatchObject({ value: { accepted: ['wss://closing.inbox.test'] } })
    expect(relay.stored.map(row => row.id)).toEqual([event.id])
    expect(relay.authenticated).toHaveLength(1)
  })

  it('uses a different throwaway key for every delivery', async () => {
    const relay = fakeRelay('wss://fresh.inbox.test'); relay.authChallenge = 'c-3'
    await run(wrap(), ['wss://fresh.inbox.test']); await run(wrap(), ['wss://fresh.inbox.test'])
    expect(new Set(relay.authenticated).size).toBe(2)
  })

  it('tries every relay even though another has already accepted', async () => {
    const open1 = fakeRelay('wss://open.inbox.test'), gated = fakeRelay('wss://gated.inbox.test'); gated.authChallenge = 'c-4'
    const second = fakeRelay('wss://gated-too.inbox.test'); second.authChallenge = 'c-5'
    const event = wrap()
    const result = await run(event, ['wss://open.inbox.test', 'wss://gated.inbox.test', 'wss://gated-too.inbox.test'])
    expect(result).toMatchObject({ value: { unaccepted: [] } })
    for (const relay of [open1, gated, second]) expect(relay.stored.map(row => row.id)).toEqual([event.id])
  })

  it('succeeds when one relay accepts and names the relay that did not', async () => {
    const good = fakeRelay('wss://good.inbox.test'), bad = fakeRelay('wss://bad.inbox.test'); bad.rejectPublishes = true; bad.rejectReason = 'restricted: no'
    const result = await run(wrap(), ['wss://good.inbox.test', 'wss://bad.inbox.test'])
    expect(result).toMatchObject({ value: { accepted: ['wss://good.inbox.test'] } })
    expect((result as { value: { unaccepted: { url: string }[] } }).value.unaccepted.map(row => row.url)).toEqual(['wss://bad.inbox.test'])
    expect(good.stored).toHaveLength(1)
  })

  it('does not retry or authenticate after a refusal that signing in cannot change', async () => {
    const relay = fakeRelay('wss://restricted.inbox.test'); relay.rejectPublishes = true; relay.rejectReason = 'restricted: not on the list'
    const result = await run(wrap(), ['wss://restricted.inbox.test'])
    expect(result).toHaveProperty('error')
    expect(relay.frames.filter(raw => JSON.parse(raw)[0] === 'EVENT')).toHaveLength(1)
    expect(relay.frames.some(raw => JSON.parse(raw)[0] === 'AUTH')).toBe(false)
    expect(relay.attempts).toBe(1)
  })

  it('rejects when no relay accepts, authentication included', async () => {
    const relay = fakeRelay('wss://hostile.inbox.test'); relay.authChallenge = 'c-6'
    relay.rejectPublishes = true; relay.rejectReason = 'blocked: no'
    const result = await run(wrap(), ['wss://hostile.inbox.test'])
    expect(result).toHaveProperty('error')
    expect(relay.stored).toHaveLength(0)
  })

  it('writes nothing once the account view is no longer current', async () => {
    const relay = fakeRelay('wss://stale.inbox.test'); relay.authChallenge = 'c-7'
    const result = await run(wrap(), ['wss://stale.inbox.test'], () => false)
    expect(result).toHaveProperty('error')
    expect(relay.frames).toHaveLength(0)
  })
})
