import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { CONFERENCE_ENDED_MESSAGE, RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { hostRoomEpoch } from './epoch.js'
import { KINDS } from './kinds.js'
import { deriveRoom } from './room.js'

// A conference room: a persistent group with a fixed end. Every event a
// member signs for it carries the end as a NIP-40 expiration, so the room's
// traffic lapses from relays that honour it. See docs/persistent-groups.md.

const SECRET = new Uint8Array(32).fill(41)
const { roomId, roomKey } = deriveRoom(SECRET)

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

function expirations(event: Event): string[] {
  return event.tags.filter((t) => t[0] === 'expiration').map((t) => t[1])
}

function member(relay: SimRelay, name: string, extra: Partial<ConstructorParameters<typeof RoomSession>[0]> = {}) {
  return new RoomSession({
    transport: new SimTransport(relay),
    secret: SECRET,
    identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(),
    name,
    announceJitterMs: 0,
    epochSettleMs: 0,
    ...extra,
  } as ConstructorParameters<typeof RoomSession>[0])
}

describe('a conference room session', () => {
  it('tags every event it publishes for the room with the room’s end', async () => {
    // The real clock: a signal stamped with a fixed test time is stale on
    // arrival and dropped, and signals are among what is checked here.
    const ends = Math.floor(Date.now() / 1000) + 86_400
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const keeper = member(relay, 'Keeper', { authority, endsAt: ends, factory: createFakeFactory() })
    const alice = member(relay, 'Alice', { authority, endsAt: ends, factory: createFakeFactory() })
    await keeper.join([], {})
    await alice.join([], {})
    await settle()
    expect(keeper.endsAt).toBe(ends)
    // A track to send makes the pair negotiate: offers and answers are
    // signal wraps.
    keeper.publishTracks([{} as MediaStreamTrack])

    await alice.chat.send('hello')
    await alice.chat.send('an answer', { replyTo: alice.chat.messages()[0]! })
    await alice.channel('notes').send('in a channel')
    await alice.setCall({ id: 'a'.repeat(32), since: Math.floor(Date.now() / 1000) })
    await keeper.publishDescriptor({ forwarders: [] })
    await settle()

    // A rekey, then a member arriving behind it asks the desk for the epoch.
    const desk = hostRoomEpoch({
      transport: new SimTransport(relay),
      roomId,
      authoritySk,
      roomKey,
      current: () => keeper.currentEpoch(),
      removed: () => keeper.removed,
      expiresAt: ends,
    })
    await keeper.rekey({ authoritySk, removed: [] })
    await settle()
    const late = member(relay, 'Late', { authority, endsAt: ends, expectedEpoch: 1, epochRequestTimeoutMs: 2_000 })
    await late.join([], {})
    await settle()
    expect(late.epoch).toBe(1)
    desk.close()

    await alice.setCall(null)
    await alice.leave()
    await settle()

    const kinds = new Set(relay.published.map((e) => e.kind))
    for (const kind of [KINDS.ROSTER, KINDS.CHAT, KINDS.SIGNAL_WRAP, KINDS.CALL_BELL, KINDS.DESCRIPTOR, KINDS.ROOM_REKEY, KINDS.EPOCH_REQUEST, KINDS.EPOCH_GRANT]) {
      expect(kinds, `kind ${kind} published`).toContain(kind)
    }
    for (const event of relay.published) {
      const tags = expirations(event)
      expect(tags, `kind ${event.kind} carries exactly one expiration`).toHaveLength(1)
      const at = Number(tags[0])
      // A signal wrap and a call bell keep their own, shorter, life;
      // everything else lapses exactly when the room ends.
      if (event.kind === KINDS.SIGNAL_WRAP || event.kind === KINDS.CALL_BELL) expect(at).toBeLessThanOrEqual(ends)
      else expect(at, `kind ${event.kind}`).toBe(ends)
    }
  })

  it('a room with no end publishes exactly what it always did', async () => {
    const relay = new SimRelay()
    const a = member(relay, 'A', { factory: createFakeFactory() })
    const b = member(relay, 'B', { factory: createFakeFactory() })
    await a.join([], {})
    await b.join([], {})
    await a.chat.send('hi')
    await settle()
    expect(a.endsAt).toBeUndefined()
    for (const event of relay.published) {
      if (event.kind === KINDS.SIGNAL_WRAP || event.kind === KINDS.CALL_BELL) continue
      expect(expirations(event), `kind ${event.kind}`).toEqual([])
    }
  })

  it('refuses to join once the room has ended, and publishes nothing', async () => {
    const relay = new SimRelay()
    const t = 1_800_000_000
    const ended = member(relay, 'Too late', { now: () => t, endsAt: t })
    await expect(ended.join([], {})).rejects.toThrow(CONFERENCE_ENDED_MESSAGE)
    expect(relay.published).toEqual([])
    const nearly = member(relay, 'Just in time', { now: () => t, endsAt: t + 1 })
    await expect(nearly.join([], {})).resolves.toBeUndefined()
  })

  it('rings no bell once the room has ended', async () => {
    const relay = new SimRelay()
    let t = 1_800_000_000
    const ends = t + 60
    const ada = member(relay, 'Ada', { now: () => t, endsAt: ends })
    await ada.join([], {})
    await settle()
    t = ends
    await ada.setCall({ id: 'b'.repeat(32), since: t })
    await settle()
    expect(relay.published.filter((e) => e.kind === KINDS.CALL_BELL)).toEqual([])
  })
})
