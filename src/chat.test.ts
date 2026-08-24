import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { deriveRoom } from './room.js'
import { encodeChatEvent, decodeChatEvent, ChatLog } from './chat.js'
import type { ChatMessage } from './chat.js'
import { KINDS } from './kinds.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const NOW = 1_800_000_000

function fixture() {
  const secret = new Uint8Array(32).fill(7)
  const { roomId, roomKey } = deriveRoom(secret)
  const deviceSk = generateSecretKey()
  const device = getPublicKey(deviceSk)
  const participant = getPublicKey(generateSecretKey())
  const msg: ChatMessage = {
    id: 'msg-1',
    participant,
    device,
    text: 'hello room',
    sentAt: NOW,
  }
  return { roomId, roomKey, deviceSk, msg }
}

describe('encodeChatEvent / decodeChatEvent', () => {
  it('round-trips a message through encryption', () => {
    const { roomId, roomKey, deviceSk, msg } = fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    const decoded = decodeChatEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded).toEqual(msg)
  })

  it('leaves the message text unreadable on the wire', () => {
    const { roomId, roomKey, deviceSk, msg } = fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    const wire = JSON.stringify(event)
    expect(wire).not.toContain(msg.text)
    expect(wire).not.toContain(msg.participant)
  })

  it('tags the event with the room id so it is subscribable', () => {
    const { roomId, roomKey, deviceSk, msg } = fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    expect(event.tags).toContainEqual(['d', roomId])
  })

  it('is a durable kind, not an ephemeral one', () => {
    const { roomId, roomKey, deviceSk, msg } = fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    expect(event.kind).toBeGreaterThanOrEqual(1000)
    expect(event.kind).toBeLessThan(10000)
  })

  it('returns null when the room key is wrong', () => {
    const { roomId, roomKey, deviceSk, msg } = fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    const wrongKey = new Uint8Array(32).fill(1)
    expect(decodeChatEvent(event, { roomId, roomKey: wrongKey, now: NOW })).toBeNull()
  })

  it('returns null when the room id does not match', () => {
    const { roomId, roomKey, deviceSk, msg } = fixture()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk })
    expect(decodeChatEvent(event, { roomId: 'a-different-room', roomKey, now: NOW })).toBeNull()
  })

  it('returns null for malformed ciphertext rather than throwing', () => {
    const { roomId, roomKey, deviceSk, msg } = fixture()
    const event = { ...encodeChatEvent(msg, { roomId, roomKey, deviceSk }), content: 'rubbish' }
    expect(() => decodeChatEvent(event, { roomId, roomKey, now: NOW })).not.toThrow()
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('returns null for a payload that decrypts but is not a chat message', () => {
    const { roomId, roomKey, deviceSk } = fixture()
    // Built by hand rather than via encodeChatEvent, which requires a
    // well-formed ChatMessage to construct a valid event in the first
    // place - this proves decodeChatEvent is defensive at runtime, not
    // merely type-safe at compile time.
    const content = nip44.v2.encrypt(JSON.stringify({ id: 'x', text: 'no participant, device, or sentAt' }), roomKey)
    const notAMessage = finalizeEvent({ kind: KINDS.CHAT, created_at: NOW, tags: [['d', roomId]], content }, deviceSk)
    expect(decodeChatEvent(notAMessage, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('returns null when the event claims a device that did not sign it', () => {
    const { roomId, roomKey, msg } = fixture()
    const impostorSk = generateSecretKey()
    const event = encodeChatEvent(msg, { roomId, roomKey, deviceSk: impostorSk })
    expect(decodeChatEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })
})

describe('ChatLog', () => {
  it('send() publishes a message that shows up in messages()', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const participant = getPublicKey(generateSecretKey())
    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, participant, deviceSk, now: () => NOW })

    await log.send('hello')

    expect(log.messages()).toHaveLength(1)
    expect(log.messages()[0]).toMatchObject({ participant, device: getPublicKey(deviceSk), text: 'hello', sentAt: NOW })
  })

  it('notifies onChange listeners when a message arrives', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const participant = getPublicKey(generateSecretKey())
    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, participant, deviceSk, now: () => NOW })
    const snapshots: number[] = []
    log.onChange((messages) => snapshots.push(messages.length))

    await log.send('hello')

    expect(snapshots.at(-1)).toBe(1)
  })

  it('orders messages by sentAt, with a deterministic id tiebreak', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const deviceSk = generateSecretKey()
    const participant = getPublicKey(generateSecretKey())
    const device = getPublicKey(deviceSk)

    const log = new ChatLog({ transport: new SimTransport(relay), roomId, roomKey, participant, deviceSk, now: () => NOW })

    // Published out of order, and with a tie on sentAt, straight onto the
    // relay - ChatLog has to do the ordering itself, not just replay
    // arrival order.
    const late: ChatMessage = { id: 'b', participant, device, text: 'later', sentAt: NOW + 10 }
    const tieHigh: ChatMessage = { id: 'z-tie', participant, device, text: 'tie-high', sentAt: NOW }
    const tieLow: ChatMessage = { id: 'a-tie', participant, device, text: 'tie-low', sentAt: NOW }

    relay.publish(encodeChatEvent(late, { roomId, roomKey, deviceSk }))
    relay.publish(encodeChatEvent(tieHigh, { roomId, roomKey, deviceSk }))
    relay.publish(encodeChatEvent(tieLow, { roomId, roomKey, deviceSk }))

    expect(log.messages().map((m) => m.text)).toEqual(['tie-low', 'tie-high', 'later'])
  })
})
