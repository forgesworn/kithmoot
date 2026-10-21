import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { deriveRoom } from './room.js'
import { chatStreamsOf, encodeChatEvent, type ChatMessage } from './chat.js'
import { deleteSignedEvents } from './self-destruct.js'
import { KINDS } from './kinds.js'

const NOW = 1_800_000_000

function message(deviceSk: Uint8Array, id: string): ChatMessage {
  // The credential is never checked on the way to a deletion.
  return { id, participant: 'ab'.repeat(32), device: getPublicKey(deviceSk), credential: {} as ChatMessage['credential'], text: 'hello', sentAt: NOW - 60 }
}

describe('deleteSignedEvents: chat envelope 2', () => {
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
