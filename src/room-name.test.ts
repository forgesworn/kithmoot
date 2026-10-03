import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { createDeviceCredential } from './credential.js'
import { encodeChatEvent, deriveChannel } from './chat.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from './control.js'
import { sanitiseDisplayName } from './display-name.js'
import { deriveRoom } from './room.js'
import {
  RoomNameBook,
  ROOM_NAME_REPOST_SECONDS,
  carryRoomNameOp,
  compareRoomNames,
  followRoomName,
  renameRoomOp,
  roomNameFromMessage,
  type RoomNameRecord,
} from './room-name.js'

const NOW = 1_800_000_000
const now = () => NOW
const SECRET = new Uint8Array(32).fill(33)
const ID_A = 'a'.repeat(32)
const ID_B = 'b'.repeat(32)
const ALICE = 'a1'.repeat(32)
const BOB = 'b0'.repeat(32)

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

function member(relay: SimRelay, name: string, authority?: string, extra: Partial<ConstructorParameters<typeof RoomSession>[0]> = {}) {
  return new RoomSession({
    transport: new SimTransport(relay),
    secret: SECRET,
    identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(),
    name,
    now,
    announceJitterMs: 0,
    authority,
    epochSettleMs: 0,
    ...extra,
  } as ConstructorParameters<typeof RoomSession>[0])
}

const message = (text: string, participant = ALICE, sentAt = NOW) => ({ text, participant, sentAt })

describe('the room name op', () => {
  it('sanitises a name as a display name is sanitised, and refuses an empty one', () => {
    const hostile = '  Book‮ club\n​night '
    const op = renameRoomOp(hostile, NOW * 1000, ID_A)
    expect(op.name).toBe(sanitiseDisplayName(hostile))
    expect(op.name).toBe('Book club night')
    expect(() => renameRoomOp('   ​\n', NOW * 1000, ID_A)).toThrow(/empty/)
    expect(() => renameRoomOp('', NOW * 1000, ID_A)).toThrow(/empty/)
  })

  it('a reader sanitises what arrives and refuses what no honest client sends', () => {
    expect(decodeControl(JSON.stringify({ op: 'name', name: 'Ops‮room', id: ID_A, at: 1 }))).toEqual({ op: 'name', name: 'Opsroom', id: ID_A, at: 1 })
    expect(decodeControl(JSON.stringify({ op: 'name', name: '​', id: ID_A, at: 1 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'name', name: 'x'.repeat(33), id: ID_A, at: 1 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'name', name: 'x'.repeat(32), id: ID_A, at: 1 }))).not.toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'name', name: 'Room', id: 'A'.repeat(32), at: 1 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'name', name: 'Room', id: ID_A, at: 1.5 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'name', name: 'Room', id: ID_A, at: 0 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'name', name: 'Room', id: ID_A, at: 1, carried: false }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'name', name: 'Room', id: ID_A, at: 1, carried: true }))).toEqual({ op: 'name', name: 'Room', id: ID_A, at: 1, carried: true })
  })

  it('a rename stamped after the second of the message carrying it is refused', () => {
    const text = encodeControl(renameRoomOp('Later', (NOW + 1) * 1000, ID_A))
    expect(roomNameFromMessage(message(text))).toBeNull()
    expect(roomNameFromMessage(message(text, ALICE, NOW + 1))).toMatchObject({ name: 'Later', by: ALICE })
  })

  it('a carried copy names nobody', () => {
    const text = encodeControl(carryRoomNameOp({ name: 'Room', id: ID_A, at: NOW * 1000 }))
    const record = roomNameFromMessage(message(text, BOB))!
    expect(record.by).toBeUndefined()
    expect(record).toMatchObject({ name: 'Room', id: ID_A, at: NOW * 1000 })
  })

  it('newest wins, then the greater id, then the name', () => {
    const r = (name: string, id: string, at: number) => ({ name, id, at })
    expect(compareRoomNames(r('Old', ID_B, 1000), r('New', ID_A, 1001))).toBeLessThan(0)
    expect(compareRoomNames(r('X', ID_A, 1000), r('Y', ID_B, 1000))).toBeLessThan(0)
    expect(compareRoomNames(r('X', ID_A, 1000), r('Y', ID_A, 1000))).toBeLessThan(0)
    expect(compareRoomNames(r('X', ID_A, 1000), r('X', ID_A, 1000))).toBe(0)
  })
})

describe('RoomNameBook', () => {
  const rec = (name: string, id: string, at: number, sentAt = Math.floor(at / 1000), by?: string): RoomNameRecord => ({ name, id, at, sentAt, ...(by ? { by } : {}) })

  it('discounts a rename read under a left epoch and stamped after the rekey that left it', () => {
    const book = new RoomNameBook()
    book.add(rec('Before', ID_A, NOW * 1000), 0)
    // Rekeyed into epoch 1 at NOW + 100; a removed member writing under the
    // old key ten minutes later is not believed once the reader moved on.
    book.add(rec('Injected', ID_B, (NOW + 700) * 1000), 0)
    expect(book.current(0)?.name).toBe('Injected')
    expect(book.current(1, { rekeyedAt: (e) => (e === 1 ? NOW + 100 : undefined) })?.name).toBe('Before')
  })

  it('wants the name carried until the current epoch holds a recent copy', () => {
    const book = new RoomNameBook()
    book.add(rec('Room', ID_A, NOW * 1000), 0)
    expect(book.carryDue(0, NOW)).toBeUndefined()
    expect(book.carryDue(1, NOW)?.name).toBe('Room')
    book.add(rec('Room', ID_A, NOW * 1000, NOW + 5), 1)
    expect(book.carryDue(1, NOW + 5)).toBeUndefined()
    expect(book.carryDue(1, NOW + 6 + ROOM_NAME_REPOST_SECONDS)?.name).toBe('Room')
  })

  it('a seed counts toward the name and is never a copy in the log', () => {
    const book = new RoomNameBook()
    book.seed({ name: 'Kept', id: ID_A, at: NOW * 1000 })
    expect(book.current(3)?.name).toBe('Kept')
    expect(book.carryDue(3, NOW)?.name).toBe('Kept')
  })
})

describe('a shared room name', () => {
  it('a rename by one member reaches another member\'s session, attributed to the renamer', async () => {
    const relay = new SimRelay()
    const alice = member(relay, 'Alice')
    const bob = member(relay, 'Bob')
    await alice.join([], {})
    await bob.join([], {})
    await settle()
    const seen: (string | undefined)[] = []
    const lines: string[] = []
    const aliceName = followRoomName(alice, { nowMs: () => NOW * 1000 + 250 })
    const bobName = followRoomName(bob, {
      onName: (r) => seen.push(r?.name),
      onRename: (r) => lines.push(`${r.by} renamed the room to “${r.name}”`),
    })
    await aliceName.rename('Book club')
    await settle()
    expect(seen).toEqual(['Book club'])
    expect(bobName.current()).toMatchObject({ name: 'Book club', by: alice.participant, at: NOW * 1000 + 250 })
    expect(lines).toEqual([`${alice.participant} renamed the room to “Book club”`])

    // The relay learns a control-channel chat event and nothing else.
    const event = relay.published.at(-1)!
    const control = deriveChannel(alice.roomId, deriveRoom(SECRET).roomKey, CONTROL_CHANNEL)
    expect(event.tags).toEqual([['d', control.id]])
    expect(event.content).not.toContain('Book club')
  })

  it('newest wins, and a tie in time breaks the same way on every device', async () => {
    const relay = new SimRelay()
    const alice = member(relay, 'Alice')
    const bob = member(relay, 'Bob')
    await alice.join([], {})
    await bob.join([], {})
    await settle()
    const a = followRoomName(alice)
    const b = followRoomName(bob)
    const at = NOW * 1000 + 500
    // Sent in the order that would lose if arrival decided it.
    await bob.channel(CONTROL_CHANNEL).send(encodeControl(renameRoomOp('Bob wins the tie', at, ID_B)))
    await alice.channel(CONTROL_CHANNEL).send(encodeControl(renameRoomOp('Alice loses the tie', at, ID_A)))
    await alice.channel(CONTROL_CHANNEL).send(encodeControl(renameRoomOp('Older', at - 1, 'f'.repeat(32))))
    await settle()
    expect(a.current()?.name).toBe('Bob wins the tie')
    expect(b.current()?.name).toBe('Bob wins the tie')
    await alice.channel(CONTROL_CHANNEL).send(encodeControl(renameRoomOp('Newest', at + 1, ID_A)))
    await settle()
    expect(a.current()?.name).toBe('Newest')
    expect(b.current()?.name).toBe('Newest')
  })

  it('a rename from outside the room, or forged for another participant, changes nothing', async () => {
    const relay = new SimRelay()
    const alice = member(relay, 'Alice')
    await alice.join([], {})
    await settle()
    const follower = followRoomName(alice)
    const { roomId, roomKey } = deriveRoom(SECRET)
    const text = encodeControl(renameRoomOp('Hijacked', NOW * 1000, ID_A))

    // A device holding the key but no credential for this room.
    const strangerSk = generateSecretKey()
    const elsewhere = await createDeviceCredential({ identity: localIdentity(generateSecretKey()), devicePubkey: getPublicKey(strangerSk), roomId: 'f'.repeat(64), expiresAt: NOW + 3600 })
    relay.publish(encodeChatEvent(
      { id: 'forged-1', participant: elsewhere.pubkey, device: getPublicKey(strangerSk), credential: elsewhere, text, sentAt: NOW },
      { roomId, roomKey, deviceSk: strangerSk, channel: CONTROL_CHANNEL },
    ))
    // A device credentialled for somebody, claiming to be Alice.
    const deviceSk = generateSecretKey()
    const credential = await createDeviceCredential({ identity: localIdentity(generateSecretKey()), devicePubkey: getPublicKey(deviceSk), roomId, expiresAt: NOW + 3600 })
    relay.publish(encodeChatEvent(
      { id: 'forged-2', participant: alice.participant, device: getPublicKey(deviceSk), credential, text, sentAt: NOW },
      { roomId, roomKey, deviceSk, channel: CONTROL_CHANNEL },
    ))
    await settle()
    expect(follower.current()).toBeUndefined()
  })

  it('a member removed by a rekey cannot read a later rename; a member admitted later reads the carried name', async () => {
    const relay = new SimRelay({ replay: true })
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', authority)
    const alice = member(relay, 'Alice', authority)
    const bob = member(relay, 'Bob', authority)
    await keeper.join([], {})
    await alice.join([], {})
    await bob.join([], {})
    await settle()
    // One clock, moving within the second the sessions are pinned to.
    let ms = NOW * 1000
    const nowMs = () => ms++
    const k = followRoomName(keeper, { nowMs })
    const a = followRoomName(alice, { nowMs })
    const b = followRoomName(bob, { nowMs })
    await a.rename('Before')
    await settle()
    expect(b.current()?.name).toBe('Before')

    await keeper.rekey({ authoritySk, removed: [bob.participant] })
    await settle()
    expect(alice.epoch).toBe(1)
    expect(bob.epoch).toBe(0)

    // The name rides into the new epoch, carried by whoever gets there.
    expect(await k.carryIfDue()).toBe(true)
    await settle()
    expect(await a.carryIfDue()).toBe(false)

    // Somebody admitted at epoch 1, who never held epoch 0's key, reads
    // the name from the carried copy alone.
    const carol = member(relay, 'Carol', authority, { epoch: keeper.currentEpoch() })
    await carol.join([], {})
    await settle()
    expect(carol.epoch).toBe(1)
    const c = followRoomName(carol)
    expect(c.current()).toMatchObject({ name: 'Before', at: NOW * 1000 })
    expect(c.current()?.by).toBeUndefined()

    await a.rename('After')
    await settle()
    expect(k.current()?.name).toBe('After')
    expect(c.current()?.name).toBe('After')
    expect(b.current()?.name).toBe('Before')
    const after = relay.published.at(-1)!
    expect(after.content).not.toContain('After')
  })
})
