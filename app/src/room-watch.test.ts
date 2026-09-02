import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { PresenceLedger, RoomWatch } from './room-watch.js'
import { deriveRoom } from '../../src/room.js'
import { createDeviceCredential } from '../../src/credential.js'
import { localIdentity } from '../../src/identity.js'
import { encodeRosterEvent } from '../../src/roster.js'
import { encodeChatEvent } from '../../src/chat.js'
import { issueKindredProof } from '../../src/access.js'
import { PRESENCE_TTL_SECONDS } from '../../src/session.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import type { DeviceCredential, KindredProof, RosterEntry } from '../../src/types.js'

const NOW = 1_800_000_000

/** Shaped like an entry; the ledger checks nothing cryptographic, so
 *  nothing here is signed. */
function entry(over: Partial<RosterEntry> & { device: string; participant: string }): RosterEntry {
  return { credential: {} as DeviceCredential, tracks: [], claims: {}, updatedAt: NOW, ...over }
}

describe('PresenceLedger', () => {
  it('groups devices by person, marks an agent, and lets the latest name win', () => {
    const ledger = new PresenceLedger()
    expect(ledger.ingest(entry({ device: 'd1', participant: 'p1', name: 'Ada', updatedAt: NOW }), NOW)).toBe(true)
    expect(ledger.ingest(entry({ device: 'd2', participant: 'p1', name: 'Ada L', updatedAt: NOW + 1 }), NOW + 1)).toBe(true)
    expect(ledger.ingest(entry({ device: 'd3', participant: 'p2', name: 'Bot', agent: true }), NOW + 1)).toBe(true)
    const present = ledger.present(NOW + 2)
    expect(present).toEqual([
      { participant: 'p1', name: 'Ada L', devices: 2, agent: false },
      { participant: 'p2', name: 'Bot', devices: 1, agent: true },
    ])
  })

  it('refuses an entry stamped before the presence window, however recently it was delivered', () => {
    // Every relay this project has been pointed at replays the last few
    // dozen roster entries to a new subscriber: the final heartbeat of
    // every device that ever died without a goodbye.
    const ledger = new PresenceLedger()
    expect(ledger.ingest(entry({ device: 'd1', participant: 'p1', updatedAt: NOW - PRESENCE_TTL_SECONDS - 1 }), NOW)).toBe(false)
    expect(ledger.present(NOW)).toEqual([])
    expect(ledger.ingest(entry({ device: 'd1', participant: 'p1', updatedAt: NOW - PRESENCE_TTL_SECONDS + 1 }), NOW)).toBe(true)
    expect(ledger.present(NOW)).toHaveLength(1)
  })

  it('drops a device that says goodbye at once, and a late entry from before the goodbye cannot bring it back', () => {
    const ledger = new PresenceLedger()
    ledger.ingest(entry({ device: 'd1', participant: 'p1', updatedAt: NOW }), NOW)
    expect(ledger.ingest(entry({ device: 'd1', participant: 'p1', updatedAt: NOW + 5, left: true }), NOW + 5)).toBe(true)
    expect(ledger.present(NOW + 5)).toEqual([])
    expect(ledger.ingest(entry({ device: 'd1', participant: 'p1', updatedAt: NOW + 3 }), NOW + 6)).toBe(false)
    expect(ledger.present(NOW + 6)).toEqual([])
    // Stamped after the goodbye: they really are back.
    expect(ledger.ingest(entry({ device: 'd1', participant: 'p1', updatedAt: NOW + 7 }), NOW + 7)).toBe(true)
    expect(ledger.present(NOW + 7)).toHaveLength(1)
  })

  it('lets a device lapse when it has not been heard from inside the window, by our clock', () => {
    const ledger = new PresenceLedger()
    ledger.ingest(entry({ device: 'd1', participant: 'p1', updatedAt: NOW }), NOW)
    expect(ledger.present(NOW + PRESENCE_TTL_SECONDS - 1)).toHaveLength(1)
    expect(ledger.present(NOW + PRESENCE_TTL_SECONDS + 1)).toEqual([])
  })

  it('never lets an older entry overwrite a newer one for the same device', () => {
    const ledger = new PresenceLedger()
    ledger.ingest(entry({ device: 'd1', participant: 'p1', name: 'New', updatedAt: NOW + 10 }), NOW + 10)
    expect(ledger.ingest(entry({ device: 'd1', participant: 'p1', name: 'Old', updatedAt: NOW }), NOW + 11)).toBe(false)
    expect(ledger.present(NOW + 11)[0]?.name).toBe('New')
  })
})

async function member(roomId: string, name: string, agent = false, proof?: (participant: string) => KindredProof) {
  const deviceSk = generateSecretKey()
  const participantSk = generateSecretKey()
  const participant = getPublicKey(participantSk)
  const credential = await createDeviceCredential({
    identity: localIdentity(participantSk),
    devicePubkey: getPublicKey(deviceSk),
    roomId,
    expiresAt: NOW + 3600,
  })
  const base = { participant, device: getPublicKey(deviceSk), credential, name, ...(proof ? { proof: proof(participant) } : {}) }
  return {
    participant,
    deviceSk,
    credential,
    heartbeat: (updatedAt: number, left = false): RosterEntry => ({
      ...base,
      tracks: [],
      claims: {},
      updatedAt,
      ...(agent ? { agent: true } : {}),
      ...(left ? { left: true } : {}),
    }),
  }
}

describe('RoomWatch', () => {
  it('counts what is new in the chat by the library’s own rules, and publishes nothing', async () => {
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(9))
    const relay = new SimRelay()
    const published: number[] = []
    relay.subscribe([{}], (event) => void published.push(event.kind))
    let clock = NOW
    let changes = 0
    const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, now: () => clock, onChange: () => changes++ })
    const ada = await member(roomId, 'Ada')
    const send = (text: string, sentAt: number, deviceSk = ada.deviceSk) =>
      new SimTransport(relay).publish(
        encodeChatEvent({ id: text, participant: ada.participant, device: getPublicKey(deviceSk), credential: ada.credential, text, sentAt }, { roomId, roomKey, deviceSk }),
      )
    await send('one', NOW - 100)
    await send('two', NOW - 50)
    await send('three', NOW - 10)
    expect(watch.unread(0)).toBe(3)
    expect(watch.unread(NOW - 50)).toBe(1)
    expect(watch.unread(NOW)).toBe(0)
    expect(changes).toBe(3)
    // A message signed by a device the credential does not name is refused
    // here exactly as it is in a member's own log.
    await send('forged', NOW - 5, generateSecretKey())
    expect(watch.unread(0)).toBe(3)
    clock = NOW + 1
    expect(published.every((kind) => kind === 1460), 'the watch published something').toBe(true)
    watch.close()
  })

  it('hears who is in the room from their heartbeats, says when it has had the chance to, and drops a goodbye', async () => {
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(10))
    const relay = new SimRelay()
    let clock = NOW
    const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, now: () => clock })
    expect(watch.settled).toBe(false)
    expect(watch.present()).toEqual([])

    const ada = await member(roomId, 'Ada')
    const bot = await member(roomId, 'Bot', true)
    const transport = new SimTransport(relay)
    await transport.publish(encodeRosterEvent(ada.heartbeat(NOW), { roomId, roomKey, deviceSk: ada.deviceSk }))
    await transport.publish(encodeRosterEvent(bot.heartbeat(NOW), { roomId, roomKey, deviceSk: bot.deviceSk }))
    expect(watch.present()).toEqual([
      { participant: ada.participant, name: 'Ada', devices: 1, agent: false },
      { participant: bot.participant, name: 'Bot', devices: 1, agent: true },
    ])
    clock = NOW + 30
    expect(watch.settled).toBe(true)

    await transport.publish(encodeRosterEvent(ada.heartbeat(NOW + 30, true), { roomId, roomKey, deviceSk: ada.deviceSk }))
    expect(watch.present().map((p) => p.name)).toEqual(['Bot'])
    watch.close()
  })

  it('keeps the room’s gate on what it hears, as a member would', async () => {
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(11))
    const hostSk = generateSecretKey()
    const policy = { tier: 'kith' as const, admitted: [getPublicKey(hostSk)] }
    const relay = new SimRelay()
    const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, policy, now: () => NOW })
    const stranger = await member(roomId, 'Stranger')
    const guest = await member(roomId, 'Guest', false, (participant) =>
      issueKindredProof({ hostSk, participant, tier: 'kith', roomId, expiresAt: NOW + 3600 }),
    )
    const transport = new SimTransport(relay)
    await transport.publish(encodeRosterEvent(stranger.heartbeat(NOW), { roomId, roomKey, deviceSk: stranger.deviceSk }))
    await transport.publish(encodeRosterEvent(guest.heartbeat(NOW), { roomId, roomKey, deviceSk: guest.deviceSk }))
    expect(watch.present().map((p) => p.name)).toEqual(['Guest'])
    watch.close()
  })
})
