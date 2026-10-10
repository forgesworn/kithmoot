import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { describe, expect, it, vi } from 'vitest'
import { dmRelayListTemplate, KIND_DM_RELAYS } from '../../src/dm-relays.js'
import type { NostrRelayPoolOptions, RelayConfig } from '../../src/relay-pool.js'
import { VMLS_REVOCATION_GIFT_WRAP_KIND, type VmlsRevocationPublication } from '../../src/vmls-revocation-request.js'
import { NostrVmlsRevocationTransport } from './mls-revocation-relay.js'

class Socket {
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []
  closed = false
  send(value: string): void { this.sent.push(value) }
  close(): void { this.closed = true }
  open(): void { this.onopen?.() }
  frame(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
}

class Pool {
  published: Event[] = []
  settledFor: number[] = []
  closed = false
  async publish(event: Event): Promise<void> { this.published.push(event) }
  async settled(timeout: number): Promise<void> { this.settledFor.push(timeout) }
  close(): void { this.closed = true }
}

function directoryEvent(key: Uint8Array, at: number, relay = 'wss://keeper.test'): Event {
  return finalizeEvent(dmRelayListTemplate([relay], at), key)
}

function wrapper(recipient: string): Event {
  return finalizeEvent({ kind: VMLS_REVOCATION_GIFT_WRAP_KIND, created_at: 1, tags: [['p', recipient]], content: 'ciphertext' }, generateSecretKey())
}

describe('NostrVmlsRevocationTransport', () => {
  it('makes bounded exact keeper-directory reads and retains only verified matching events', async () => {
    const keeperKey = generateSecretKey(), keeper = getPublicKey(keeperKey), otherKey = generateSecretKey()
    const old = directoryEvent(keeperKey, 10), latest = directoryEvent(keeperKey, 20, 'wss://latest.test')
    const altered = { ...directoryEvent(keeperKey, 30), content: 'altered' }
    const foreign = directoryEvent(otherKey, 40)
    const one = new Socket(), two = new Socket(), sockets = new Map([['wss://one.test/', one], ['wss://two.test/', two]])
    const transport = new NostrVmlsRevocationTransport(['wss://one.test', 'wss://two.test'], {
      socket: url => sockets.get(url)! as unknown as WebSocket, lookupMs: 321, drainMs: 0,
    })
    const pending = transport.directory(keeper)
    one.open(); two.open()
    const first = JSON.parse(one.sent[0]!), second = JSON.parse(two.sent[0]!)
    expect(first).toEqual(['REQ', expect.stringMatching(/^vmls-revocation-/), { kinds: [KIND_DM_RELAYS], authors: [keeper], limit: 8 }])
    expect(second).toEqual(['REQ', expect.stringMatching(/^vmls-revocation-/), { kinds: [KIND_DM_RELAYS], authors: [keeper], limit: 8 }])
    expect(one.sent.concat(two.sent).some(frame => frame.includes('AUTH'))).toBe(false)
    for (const event of [old, altered, foreign]) one.frame(['EVENT', first[1], event])
    for (const event of [latest, old]) two.frame(['EVENT', second[1], event])
    one.frame(['EOSE', first[1]])
    two.frame(['CLOSED', second[1], 'restricted'])
    await expect(pending.then(events => events.map(event => event.id))).resolves.toEqual([latest.id, old.id])
    expect(one.closed).toBe(true); expect(two.closed).toBe(true)
  })

  it('caps a relay that ignores its requested limit while waiting for EOSE', async () => {
    const keeperKey = generateSecretKey(), keeper = getPublicKey(keeperKey), socket = new Socket()
    const events = Array.from({ length: 12 }, (_, index) => directoryEvent(keeperKey, index + 1, `wss://relay-${index}.test`))
    const transport = new NostrVmlsRevocationTransport(['wss://directory.test'], {
      socket: () => socket as unknown as WebSocket, lookupMs: 100,
    })
    const pending = transport.directory(keeper)
    socket.open(); const id = JSON.parse(socket.sent[0]!)[1]
    for (const event of events) socket.frame(['EVENT', id, event])
    socket.frame(['EOSE', id])
    const found = await pending
    expect(found).toHaveLength(8)
    expect(found.map(event => event.id).sort()).toEqual(events.slice(0, 8).map(event => event.id).sort())
  })

  it('does not turn total directory silence into evidence that no list exists', async () => {
    const socket = new Socket()
    const transport = new NostrVmlsRevocationTransport(['wss://silent.test'], {
      socket: () => socket as unknown as WebSocket, lookupMs: 100,
    })
    const pending = transport.directory('11'.repeat(32))
    socket.open(); socket.onclose?.()
    await expect(pending).rejects.toThrow('did not complete')
    expect(socket.closed).toBe(true)
  })

  it('publishes a strict wrapper on a fresh unauthenticated write-only pool and drains finitely', async () => {
    const recipient = '22'.repeat(32), event = wrapper(recipient), pool = new Pool()
    const made: { relays: readonly RelayConfig[]; options: NostrRelayPoolOptions }[] = []
    const transport = new NostrVmlsRevocationTransport(['wss://directory.test'], {
      pool: (relays, options) => { made.push({ relays, options }); return pool }, lookupMs: 100, drainMs: 456,
    })
    const publication: VmlsRevocationPublication = { relays: ['wss://keeper.test'], event, authenticate: false }
    await expect(transport.publish(publication)).resolves.toBeUndefined()
    expect(made).toEqual([{ relays: [{ url: 'wss://keeper.test/', read: false, write: true }], options: { authentication: [] } }])
    expect(pool.published).toEqual([event])
    expect(pool.settledFor).toEqual([456])
    expect(pool.closed).toBe(true)
  })

  it('refuses malformed or identity-authenticated publication before opening a pool', async () => {
    const make = vi.fn(() => new Pool()), recipient = '33'.repeat(32), event = wrapper(recipient)
    const transport = new NostrVmlsRevocationTransport(['wss://directory.test'], { pool: make, lookupMs: 100, drainMs: 0 })
    await expect(transport.publish({ relays: ['wss://keeper.test'], event: { ...event, tags: [['p', recipient], ['x', 'leak']] }, authenticate: false }))
      .rejects.toThrow('Invalid VMLS revocation publication')
    await expect(transport.publish({ relays: ['wss://keeper.test'], event, authenticate: true } as unknown as VmlsRevocationPublication))
      .rejects.toThrow('Invalid VMLS revocation publication')
    expect(make).not.toHaveBeenCalled()
  })
})
