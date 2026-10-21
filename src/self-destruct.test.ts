import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { deriveRoom } from './room.js'
import { chatStreamsOf, encodeChatEvent, type ChatMessage } from './chat.js'
import { deleteSignedEvents } from './self-destruct.js'
import { KINDS } from './kinds.js'
import { matchFilters } from 'nostr-tools/filter'
import type { RelayTransport } from './relay-pool.js'
import * as chat from './chat.js'

const NOW = 1_800_000_000

function message(deviceSk: Uint8Array, id: string): ChatMessage {
  // The credential is never checked on the way to a deletion.
  return { id, participant: 'ab'.repeat(32), device: getPublicKey(deviceSk), credential: {} as ChatMessage['credential'], text: 'hello', sentAt: NOW - 60 }
}

describe('deleteSignedEvents: chat envelope 2', () => {
  it('erases the real derived outer key when the deadline expires before publication', async () => {
    const relay = new SimRelay({ replay: true }), transport = new SimTransport(relay)
    const deviceSk = generateSecretKey(), { roomId, roomKey } = deriveRoom(generateSecretKey())
    relay.publish(encodeChatEvent(message(deviceSk, 'expired'), { roomId, roomKey, deviceSk, envelope: 2 }))
    const realDecoder = chat.ownEnvelope2Events, derived: Uint8Array[] = []
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
    const decoder = vi.spyOn(chat, 'ownEnvelope2Events').mockImplementation((...args) => {
      const own = realDecoder(...args)
      derived.push(...own.map(o => o.sk))
      clock.mockReturnValue(NOW * 1000 + 2000)
      return own
    })
    try {
      const report = await deleteSignedEvents({ transport, keys: [], now: () => NOW, timeoutMs: 1000, chat: { deviceSk, streams: chatStreamsOf([{ id: roomId, key: roomKey }], [undefined]) } })
      expect(report.complete).toBe(false)
      expect(report.failed).toBe(1)
      expect(derived).toHaveLength(1)
      expect([...derived[0]!]).toEqual(Array(32).fill(0))
      expect(relay.published.filter(e => e.kind === 5)).toEqual([])
    } finally {
      decoder.mockRestore()
      clock.mockRestore()
    }
  })

  it('reports incomplete discovery when a full same-second page hides older own chat', async () => {
    const deviceSk = generateSecretKey(), otherSk = generateSecretKey()
    const { roomId, roomKey } = deriveRoom(generateSecretKey())
    const mine = encodeChatEvent({ ...message(deviceSk, 'older-mine'), sentAt: NOW - 2000 }, { roomId, roomKey, deviceSk, envelope: 2 })
    const history = [mine, ...Array.from({ length: 1000 }, (_, i) => encodeChatEvent({ ...message(otherSk, `foreign-${i}`), sentAt: NOW - 100 }, { roomId, roomKey, deviceSk: otherSk, envelope: 2 }))]
    const published: Event[] = []
    const transport: RelayTransport = {
      publish: async event => { published.push(event) },
      subscribe: (filters, onEvent, onEose) => {
        for (const filter of filters) for (const event of history.filter(e => matchFilters([filter], e)).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, filter.limit)) onEvent(event)
        onEose?.()
        return () => {}
      },
      close: () => {},
    }
    const report = await deleteSignedEvents({ transport, keys: [], now: () => NOW, timeoutMs: 10_000, chat: { deviceSk, streams: chatStreamsOf([{ id: roomId, key: roomKey }], [undefined]) } })
    expect(report.complete).toBe(false)
    expect(published).toEqual([])
  }, 30_000)

  it('asks for each of this device\'s envelope-2 messages under its own outer key, and nobody else\'s', async () => {
    const relay = new SimRelay({ replay: true })
    const transport = new SimTransport(relay)
    const { roomId, roomKey } = deriveRoom(generateSecretKey())
    const deviceSk = generateSecretKey()
    const otherSk = generateSecretKey()
    const opts = { roomId, roomKey }
    const mine = [encodeChatEvent(message(deviceSk, 'm-1'), { ...opts, deviceSk, envelope: 2 }), encodeChatEvent(message(deviceSk, 'm-2'), { ...opts, deviceSk, envelope: 2 })]
    const old = encodeChatEvent(message(deviceSk, 'm-0'), { ...opts, deviceSk })
    const theirs = encodeChatEvent(message(otherSk, 'o-1'), { ...opts, deviceSk: otherSk, envelope: 2 })
    for (const e of [...mine, old, theirs]) relay.publish(e)

    const report = await deleteSignedEvents({
      transport,
      keys: [{ sk: deviceSk }],
      now: () => NOW,
      timeoutMs: 2_000,
      chat: { deviceSk, streams: chatStreamsOf([{ id: roomId, key: roomKey }], [undefined]) },
    })

    expect(report.failed).toBe(0)
    expect(report.found).toBe(3)
    const deletions = relay.published.filter((e: Event) => e.kind === 5)
    const asks = (e: Event) => e.tags.filter((t) => t[0] === 'e').map((t) => t[1])
    // The device key asks for its envelope-1 message, as before.
    expect(deletions.find((d: Event) => d.pubkey === getPublicKey(deviceSk))!.tags).toContainEqual(['e', old.id])
    // Each envelope-2 message is asked for by its own author, alone.
    for (const e of mine) {
      const ask = deletions.find((d: Event) => d.pubkey === e.pubkey)
      expect(ask).toBeDefined()
      expect(asks(ask!)).toEqual([e.id])
      expect(ask!.tags).toContainEqual(['k', String(KINDS.CHAT)])
    }
    expect(deletions.some((d: Event) => asks(d).includes(theirs.id))).toBe(false)
  })

  it('leaves envelope-2 chat alone without streams, as before', async () => {
    const relay = new SimRelay({ replay: true })
    const transport = new SimTransport(relay)
    const { roomId, roomKey } = deriveRoom(generateSecretKey())
    const deviceSk = generateSecretKey()
    const e = encodeChatEvent(message(deviceSk, 'm-1'), { roomId, roomKey, deviceSk, envelope: 2 })
    relay.publish(e)
    const report = await deleteSignedEvents({ transport, keys: [{ sk: deviceSk }], now: () => NOW, timeoutMs: 1_000 })
    expect(report.found).toBe(0)
    expect(relay.published.filter((d: Event) => d.kind === 5)).toHaveLength(0)
  })
})
