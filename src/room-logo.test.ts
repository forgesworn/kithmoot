import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { createDeviceCredential } from './credential.js'
import { decodeChatEvent, deriveChannel, encodeChatEvent, type ChatMessage } from './chat.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from './control.js'
import { createLogoImage } from './logo-image.js'
import { deriveRoom } from './room.js'
import { KINDS } from './kinds.js'
import { RoomLogoBook, followRoomLogo, roomLogoFromMessage, roomLogoOp, type RoomLogoRecord } from './room-logo.js'
import { ROOM_NAME_REPOST_SECONDS } from './room-name.js'

const NOW = 1_800_000_000, SECRET = new Uint8Array(32).fill(33), ID = 'a'.repeat(32)
const image = createLogoImage(new Uint8Array(readFileSync(new URL('../desktop/icons/kithmoot-128.png', import.meta.url))), 'image/png')
const sessions: RoomSession[] = []
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.leave())) })
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
function member(relay: SimRelay, extra: Partial<Pick<ConstructorParameters<typeof RoomSession>[0], 'authority' | 'epoch'>> = {}) {
  const session = new RoomSession({ transport: new SimTransport(relay), secret: SECRET,
    identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), name: 'Member',
    now: () => NOW, announceJitterMs: 0, epochSettleMs: 0, ...extra })
  sessions.push(session); return session
}
async function wireFixture() {
  const { roomId, roomKey } = deriveRoom(SECRET), deviceSk = generateSecretKey(), identity = localIdentity(generateSecretKey())
  const credential = await createDeviceCredential({ identity, devicePubkey: getPublicKey(deviceSk), roomId, expiresAt: NOW + 3600 })
  const msg: ChatMessage = { id: ID, participant: credential.pubkey, device: getPublicKey(deviceSk), credential,
    text: encodeControl(roomLogoOp(image, NOW * 1000, ID)), sentAt: NOW, roomLogo: image }
  const rawEvent = (value: unknown, channel = CONTROL_CHANNEL) => {
    const derived = deriveChannel(roomId, roomKey, channel)
    return finalizeEvent({ kind: KINDS.CHAT, created_at: NOW, tags: [['d', derived.id]],
      content: nip44.v2.encrypt(JSON.stringify(value), derived.key) }, deviceSk)
  }
  return { roomId, roomKey, deviceSk, msg, rawEvent }
}

describe('private room logo wire boundary', () => {
  it('round-trips an inline logo and its explicit removal without exposing pixels on the relay', async () => {
    const { msg, roomId, roomKey, deviceSk } = await wireFixture()
    for (const value of [image, null]) {
      const message = { ...msg, text: encodeControl(roomLogoOp(value, NOW * 1000, ID)), roomLogo: value }
      const event = encodeChatEvent(message, { roomId, roomKey, deviceSk, channel: CONTROL_CHANNEL })
      const decoded = decodeChatEvent(event, { roomId, roomKey, channel: CONTROL_CHANNEL, now: NOW })!
      expect(decoded.roomLogo).toEqual(value)
      expect(roomLogoFromMessage(decoded)).toMatchObject({ image: value, by: msg.participant })
      expect(event.content).not.toContain(image.data); expect(event.content).not.toContain(image.sha256)
      expect(decodeControl(decoded.text)?.op).toBe('logo')
    }
  })
  it('rejects malformed, remote, mismatched, mixed and ordinary-channel metadata after real decryption', async () => {
    const { msg, roomId, roomKey, rawEvent } = await wireFixture()
    const invalid = [
      { ...msg, roomLogo: { ...image, url: 'https://tracker.invalid/logo.png' } },
      { ...msg, roomLogo: null }, { ...msg, text: encodeControl(roomLogoOp(null, NOW * 1000, ID)) },
      { ...msg, text: 'hello' }, { ...msg, reaction: { target: ID, emoji: '👍' } },
      { ...msg, attachments: [] }, { ...msg, reply: ID }, { ...msg, artwork: [] },
    ]
    for (const message of invalid) expect(decodeChatEvent(rawEvent(message), { roomId, roomKey, channel: CONTROL_CHANNEL, now: NOW })).toBeNull()
    expect(decodeChatEvent(rawEvent(msg, 'main'), { roomId, roomKey, channel: 'main', now: NOW })).toBeNull()
  })
  it('rejects a borrowed credential and a future change even when a room-key holder signs the outer event', async () => {
    const { msg, roomId, roomKey, rawEvent } = await wireFixture()
    expect(decodeChatEvent(rawEvent({ ...msg, participant: getPublicKey(generateSecretKey()) }), { roomId, roomKey, channel: CONTROL_CHANNEL, now: NOW })).toBeNull()
    const future = { ...msg, text: encodeControl(roomLogoOp(image, (NOW + 1) * 1000, ID)) }
    expect(roomLogoFromMessage(future)).toBeUndefined()
    expect(decodeControl(JSON.stringify({ ...roomLogoOp(image, NOW * 1000, ID), url: 'https://tracker.invalid' }))).toBeNull()
  })
})

describe('shared room logo state', () => {
  it('discounts removed-member writes, keeps removals through rekey and never lends a mutable cache to a renderer', () => {
    const book = new RoomLogoBook()
    const record: RoomLogoRecord = { image, id: ID, at: NOW * 1000, sentAt: NOW }
    book.add(record, 0)
    book.add({ ...record, image: null, id: 'b'.repeat(32), at: (NOW + 700) * 1000, sentAt: NOW + 700 }, 0)
    const epochs = { rekeyedAt: () => NOW + 100 }
    expect(book.current(1, epochs)?.image).toEqual(image)
    const borrowed = book.current(1, epochs)!; borrowed.image!.data = 'tampered'
    expect(book.current(1, epochs)?.image).toEqual(image)
    const clear = { ...record, image: null, id: 'c'.repeat(32), at: (NOW + 101) * 1000, sentAt: NOW + 101 }
    book.add(clear, 1)
    expect(book.carryDue(2, NOW + 102, epochs)?.image).toBeNull()
    book.add({ ...clear, sentAt: NOW + 102 }, 2)
    expect(book.carryDue(2, NOW + 102, epochs)).toBeUndefined()
    expect(book.carryDue(2, NOW + 103 + ROOM_NAME_REPOST_SECONDS, epochs)?.image).toBeNull()
    book.seed({ ...record, image: { ...image, sha256: '00'.repeat(32) } })
    expect(book.current(2, epochs)?.image).toBeNull()
  })
  it('shares replacement and removal between admitted sessions while an ordinary chat stays empty', async () => {
    const relay = new SimRelay(), alice = member(relay), bob = member(relay)
    await alice.join([], {}); await bob.join([], {}); await settle()
    const a = followRoomLogo(alice, { nowMs: () => NOW * 1000 }), received: (string | null | undefined)[] = []
    const b = followRoomLogo(bob, { onLogo: record => received.push(record?.image?.sha256 ?? (record ? null : undefined)) })
    await a.replace(image); await settle()
    expect(b.current()).toMatchObject({ image, by: alice.participant })
    expect(bob.channel('main').messages()).toEqual([])
    a.close()
    const clearer = followRoomLogo(alice, { nowMs: () => NOW * 1000 + 1 })
    await clearer.replace(null); await settle()
    expect(received).toEqual([image.sha256, null]); expect(b.current()?.image).toBeNull()
    b.close(); clearer.close()
    await expect(a.replace(image)).rejects.toThrow('closed')
  })
  it('prepares one immutable signed event, rejects mixed statements, and ignores a failed renderer', async () => {
    const relay = new SimRelay(), alice = member(relay)
    await alice.join([], {}); await settle()
    const log = alice.channel(CONTROL_CHANNEL), copy = { ...image }, text = encodeControl(roomLogoOp(copy, NOW * 1000, ID))
    expect(() => log.prepare(text, { roomLogo: copy, replyTo: { id: ID, participant: alice.participant } })).toThrow()
    expect(() => log.prepare(text, { roomLogo: copy, artwork: [] })).toThrow()
    expect(() => alice.channel('main').prepare(text, { roomLogo: copy })).toThrow('envelope')
    const prepared = log.prepare(text, { roomLogo: copy }); copy.data = 'mutated'
    const follower = followRoomLogo(alice, { onLogo: () => { throw new Error('renderer failed') } })
    await prepared.publish(); await prepared.publish(); await settle()
    expect(follower.current()?.image).toEqual(image)
    expect(log.messages().filter(message => message.id === prepared.message.id)).toHaveLength(1)
    follower.close()
  })
  it('carries into a new epoch for later arrivals without revealing a later change to a removed member', async () => {
    const relay = new SimRelay({ replay: true }), authoritySk = generateSecretKey(), authority = getPublicKey(authoritySk)
    const alice = member(relay, { authority }), bob = member(relay, { authority })
    await alice.join([], {}); await bob.join([], {}); await settle()
    let ms = NOW * 1000
    const a = followRoomLogo(alice, { nowMs: () => ms++ }), b = followRoomLogo(bob)
    await a.replace(image); await settle()
    await alice.rekey({ authoritySk, removed: [bob.participant] }); await settle()
    expect(alice.epoch).toBe(1); expect(bob.epoch).toBe(0)
    expect(await a.carryIfDue()).toBe(true); await settle()
    expect(await a.carryIfDue()).toBe(false)
    const carol = member(relay, { authority, epoch: alice.currentEpoch() })
    await carol.join([], {}); await settle()
    const c = followRoomLogo(carol)
    expect(c.current()?.image).toEqual(image); expect(c.current()?.by).toBeUndefined()
    await a.replace(null); await settle()
    expect(c.current()?.image).toBeNull(); expect(b.current()?.image).toEqual(image)
    a.close(); b.close(); c.close()
  })
})
