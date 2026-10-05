import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { PresenceLedger, RoomWatch, type WatchedRekey } from './room-watch.js'
import { deriveRoom } from '../../src/room.js'
import { createDeviceCredential } from '../../src/credential.js'
import { localIdentity } from '../../src/identity.js'
import { encodeRosterEvent } from '../../src/roster.js'
import { encodeChatEvent } from '../../src/chat.js'
import { deriveEpoch, encodeRekeyEvent, generateEpochSecret, type RoomEpoch } from '../../src/epoch.js'
import { generateSealKey } from '../../src/seal.js'
import { CONTROL_CHANNEL, encodeControl } from '../../src/control.js'
import { renameRoomOp } from '../../src/room-name.js'
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
    const observer = 'f'.repeat(64)
    expect(watch.unread(0, observer)).toEqual({ people: 3, agents: 0 })
    expect(watch.unread(NOW - 50, observer)).toEqual({ people: 1, agents: 0 })
    expect(watch.unread(NOW, observer)).toEqual({ people: 0, agents: 0 })
    expect(changes).toBe(3)
    // A message signed by a device the credential does not name is refused
    // here exactly as it is in a member's own log.
    await send('forged', NOW - 5, generateSecretKey())
    expect(watch.unread(0, observer)).toEqual({ people: 3, agents: 0 })
    // The sender's own messages never count, even read back through a
    // watch that never joined the room.
    expect(watch.unread(0, ada.participant)).toEqual({ people: 0, agents: 0 })
    clock = NOW + 1
    expect(published.every((kind) => kind === 1460), 'the watch published something').toBe(true)
    watch.close()
  })

  it('splits people from agents, and knows the viewer by name even though a watch never joins the roster', async () => {
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(12))
    const relay = new SimRelay()
    const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, now: () => NOW })
    const ada = await member(roomId, 'Ada')
    const bot = await member(roomId, 'Bot', true)
    const transport = new SimTransport(relay)
    await transport.publish(encodeRosterEvent(bot.heartbeat(NOW), { roomId, roomKey, deviceSk: bot.deviceSk }))
    const send = (participant: typeof ada, text: string, sentAt: number) =>
      transport.publish(encodeChatEvent(
        { id: text, participant: participant.participant, device: getPublicKey(participant.deviceSk), credential: participant.credential, text, sentAt },
        { roomId, roomKey, deviceSk: participant.deviceSk },
      ))
    await send(ada, 'hello', NOW - 10)
    // The bot names the viewer by their display name in plain text, never
    // on the wire as a `mentions` field - the legacy reading `mentionsOf`
    // still has to work here, off a roster this watch built itself.
    await send(bot, 'over to Tally', NOW - 5)
    await send(bot, 'over to you', NOW - 4)
    expect(watch.unread(0, 't'.repeat(64), 'Tally')).toEqual({ people: 1, agents: 1 })
    watch.close()
  })

  it('does not count a message its own author has retracted, so the rooms list and the desktop badge agree', async () => {
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(13))
    const relay = new SimRelay()
    const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, now: () => NOW })
    const ada = await member(roomId, 'Ada')
    const transport = new SimTransport(relay)
    const send = (id: string, text: string, sentAt: number, extra: Record<string, unknown> = {}) =>
      transport.publish(encodeChatEvent(
        { id, participant: ada.participant, device: getPublicKey(ada.deviceSk), credential: ada.credential, text, sentAt, ...extra },
        { roomId, roomKey, deviceSk: ada.deviceSk },
      ))
    await send('m1', 'oops', NOW - 10)
    await send('r1', 'Retracted a message', NOW - 5, { retracts: 'm1' })
    expect(watch.unread(0, 't'.repeat(64))).toEqual({ people: 0, agents: 0 })
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

  it('reads the room where it was last seen: chat, presence and its shared name under a later epoch', async () => {
    const secret = new Uint8Array(32).fill(13)
    const { roomId, roomKey } = deriveRoom(secret)
    const keys = deriveEpoch({ epoch: 2, secret: new Uint8Array(32).fill(14) })
    const epoch = { epoch: 2, id: keys.id, key: keys.key }
    const relay = new SimRelay()
    let changes = 0
    const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, epoch, now: () => NOW, onChange: () => changes++ })
    const ada = await member(roomId, 'Ada')
    const transport = new SimTransport(relay)
    const message = (text: string, sentAt: number) => ({ id: `${text}-${sentAt}`, participant: ada.participant, device: getPublicKey(ada.deviceSk), credential: ada.credential, text, sentAt })
    const rename = (name: string, sentAt: number, under?: typeof epoch) =>
      transport.publish(encodeChatEvent(message(encodeControl(renameRoomOp(name, sentAt * 1000)), sentAt),
        { roomId, roomKey, deviceSk: ada.deviceSk, channel: CONTROL_CHANNEL, ...(under ? { epoch: under } : {}) }))
    // Under epoch 0, which the room has left: not read.
    await rename('Stale', NOW - 30)
    await transport.publish(encodeChatEvent(message('old', NOW - 30), { roomId, roomKey, deviceSk: ada.deviceSk }))
    expect(watch.roomName()).toBeUndefined()
    expect(watch.messages()).toEqual([])
    // Under the epoch it is in now: read.
    await rename('The moot', NOW - 20, epoch)
    expect(watch.roomName()?.name).toBe('The moot')
    expect(watch.roomName()?.by).toBe(ada.participant)
    await rename('Newer', NOW - 10, epoch)
    await rename('Older', NOW - 15, epoch)
    expect(watch.roomName()?.name).toBe('Newer')
    await transport.publish(encodeChatEvent(message('hello', NOW - 5), { roomId, roomKey, deviceSk: ada.deviceSk, epoch }))
    expect(watch.messages().map((m) => m.text)).toEqual(['hello'])
    await transport.publish(encodeRosterEvent(ada.heartbeat(NOW), { roomId, roomKey, deviceSk: ada.deviceSk, epoch }))
    expect(watch.present().map((p) => p.name)).toEqual(['Ada'])
    expect(changes).toBeGreaterThanOrEqual(5)
    watch.close()
  })

  it('reads a rename in a room never rekeyed, and none in a quiet room', async () => {
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(15))
    const relay = new SimRelay({ replay: true })
    const ada = await member(roomId, 'Ada')
    const op = encodeChatEvent(
      { id: 'n', participant: ada.participant, device: getPublicKey(ada.deviceSk), credential: ada.credential, text: encodeControl(renameRoomOp('Kitchen', (NOW - 5) * 1000)), sentAt: NOW - 5 },
      { roomId, roomKey, deviceSk: ada.deviceSk, channel: CONTROL_CHANNEL },
    )
    await new SimTransport(relay).publish(op)
    // Already on the relay when the watch opens, as on a cold start.
    // Read as the watch opens, so the caller asks for it then rather than
    // waiting for a change.
    const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, now: () => NOW })
    const quiet = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, quiet: true, now: () => NOW })
    expect(watch.roomName()?.name).toBe('Kitchen')
    expect(quiet.roomName()).toBeUndefined()
    watch.close()
    quiet.close()
  })

  describe('following rekeys', () => {
    const secret = new Uint8Array(32).fill(31)
    const { roomId, roomKey } = deriveRoom(secret)
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const deviceSk = generateSecretKey()
    const device = getPublicKey(deviceSk)
    const keysOf = (e: RoomEpoch) => deriveEpoch(e)
    const zero = { epoch: 0, id: roomId, key: roomKey }
    const rekey = (from: { epoch: number; id: string; key: Uint8Array }, next: RoomEpoch, opts: { recipients?: Parameters<typeof encodeRekeyEvent>[0]['recipients']; removed?: string[]; closed?: boolean; scheduled?: boolean; sk?: Uint8Array; at?: number } = {}) =>
      encodeRekeyEvent({
        roomId,
        authoritySk: opts.sk ?? authoritySk,
        current: from,
        next,
        recipients: opts.recipients ?? [device],
        removed: opts.removed ?? [],
        ...(opts.closed ? { closed: true } : {}),
        ...(opts.scheduled ? { scheduled: true } : {}),
        commit: true,
        now: opts.at ?? NOW - 10,
      })

    it('follows a rekey with this device\u2019s copy: reads the new epoch, keeps reading the one left, and says so', async () => {
      const relay = new SimRelay()
      const moved: WatchedRekey[] = []
      let changes = 0
      const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, authority, deviceSk, now: () => NOW, onEpoch: (m) => moved.push(m), onChange: () => changes++ })
      const ada = await member(roomId, 'Ada')
      const transport = new SimTransport(relay)
      const message = (text: string, sentAt: number) => ({ id: `${text}-${sentAt}`, participant: ada.participant, device: getPublicKey(ada.deviceSk), credential: ada.credential, text, sentAt })
      await transport.publish(encodeChatEvent(message('before', NOW - 20), { roomId, roomKey, deviceSk: ada.deviceSk }))

      const one = { epoch: 1, secret: generateEpochSecret() }
      await transport.publish(rekey(zero, one, { scheduled: true }))
      expect(watch.epoch).toBe(1)
      expect(moved).toHaveLength(1)
      expect(moved[0]!.epoch).toEqual(one)
      expect(moved[0]!.left).toEqual(zero)
      expect(moved[0]!.notice).toMatchObject({ epoch: 1, scheduled: true, at: NOW - 10 })
      expect(changes).toBeGreaterThan(0)

      // The new epoch is read; the one left still is, for a late message.
      const under = { id: keysOf(one).id, key: keysOf(one).key }
      await transport.publish(encodeChatEvent(message('after', NOW - 5), { roomId, roomKey, deviceSk: ada.deviceSk, epoch: under }))
      await transport.publish(encodeChatEvent(message('late', NOW - 15), { roomId, roomKey, deviceSk: ada.deviceSk }))
      expect(watch.messages().map((m) => m.text)).toEqual(['before', 'late', 'after'])
      // Presence is read there too, and no longer under epoch 0.
      await transport.publish(encodeRosterEvent(ada.heartbeat(NOW), { roomId, roomKey, deviceSk: ada.deviceSk, epoch: under }))
      expect(watch.present().map((p) => p.name)).toEqual(['Ada'])
      watch.close()
    })

    it('catches up through several replayed rekeys, the later ones sealed to its seal key', async () => {
      const relay = new SimRelay({ replay: true })
      const seal = generateSealKey()
      const participantSk = generateSecretKey()
      const credential = await createDeviceCredential({ identity: localIdentity(participantSk), devicePubkey: device, roomId, expiresAt: NOW + 3600, seal: seal.pubkey })
      const one = { epoch: 1, secret: generateEpochSecret() }
      const two = { epoch: 2, secret: generateEpochSecret() }
      const three = { epoch: 3, secret: generateEpochSecret() }
      const transport = new SimTransport(relay)
      // Out of order, as relays deliver.
      await transport.publish(rekey(keysOf(two), three, { recipients: [{ device, credential }], at: NOW - 3 }))
      await transport.publish(rekey(zero, one, { at: NOW - 9 }))
      await transport.publish(rekey(keysOf(one), two, { recipients: [{ device, credential }], at: NOW - 6 }))
      const moved: WatchedRekey[] = []
      const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, authority, deviceSk, sealSks: () => [seal.secretKey], now: () => NOW, onEpoch: (m) => moved.push(m) })
      expect(watch.epoch).toBe(3)
      expect(moved.map((m) => [m.left.epoch, m.epoch.epoch, m.notice.at])).toEqual([[0, 1, NOW - 9], [1, 2, NOW - 6], [2, 3, NOW - 3]])
      watch.close()

      // Without the seal key it opens the first, and stops at the second.
      const without = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, authority, deviceSk, now: () => NOW })
      expect(without.epoch).toBe(1)
      without.close()
    })

    it('starts from the epoch it was given, and reads the epochs kept before it', async () => {
      const relay = new SimRelay({ replay: true })
      const one = { epoch: 1, secret: generateEpochSecret() }
      const two = { epoch: 2, secret: generateEpochSecret() }
      const ada = await member(roomId, 'Ada')
      const transport = new SimTransport(relay)
      const message = (text: string, sentAt: number) => ({ id: `${text}-${sentAt}`, participant: ada.participant, device: getPublicKey(ada.deviceSk), credential: ada.credential, text, sentAt })
      await transport.publish(encodeChatEvent(message('in epoch 1', NOW - 20), { roomId, roomKey, deviceSk: ada.deviceSk, epoch: keysOf(one) }))
      await transport.publish(rekey(keysOf(one), two))
      const moved: WatchedRekey[] = []
      const watch = new RoomWatch({
        transport: new SimTransport(relay),
        roomId,
        roomKey,
        authority,
        deviceSk,
        epoch: keysOf(one),
        pastEpochs: [{ leftAt: NOW - 30 }],
        now: () => NOW,
        onEpoch: (m) => moved.push(m),
      })
      expect(watch.epoch).toBe(2)
      expect(moved.map((m) => m.left.epoch)).toEqual([1])
      expect(watch.messages().map((m) => m.text)).toEqual(['in epoch 1'])
      watch.close()
    })

    it('stays where it is when the rekey has no copy for it: removed, closed, or signed by somebody else', async () => {
      const relay = new SimRelay({ replay: true })
      const transport = new SimTransport(relay)
      const someone = getPublicKey(generateSecretKey())
      const one = { epoch: 1, secret: generateEpochSecret() }
      const removing = rekey(zero, one, { recipients: [someone], removed: [getPublicKey(generateSecretKey())] })
      await transport.publish(removing)
      const moved: WatchedRekey[] = []
      const watch = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, authority, deviceSk, now: () => NOW, onEpoch: (m) => moved.push(m) })
      expect(watch.epoch).toBe(0)

      // Closing seals the secret to nobody.
      const closedRelay = new SimRelay({ replay: true })
      await new SimTransport(closedRelay).publish(rekey(zero, one, { recipients: [], closed: true }))
      const closed = new RoomWatch({ transport: new SimTransport(closedRelay), roomId, roomKey, authority, deviceSk, now: () => NOW, onEpoch: (m) => moved.push(m) })
      expect(closed.epoch).toBe(0)

      // Signed by a key that is not the room's authority.
      const forgedRelay = new SimRelay({ replay: true })
      await new SimTransport(forgedRelay).publish(rekey(zero, one, { sk: generateSecretKey() }))
      const forged = new RoomWatch({ transport: new SimTransport(forgedRelay), roomId, roomKey, authority, deviceSk, now: () => NOW, onEpoch: (m) => moved.push(m) })
      expect(forged.epoch).toBe(0)

      // And with no device key it does not follow at all.
      const keyless = new RoomWatch({ transport: new SimTransport(relay), roomId, roomKey, authority, now: () => NOW })
      expect(keyless.epoch).toBe(0)
      expect(moved).toEqual([])
      for (const w of [watch, closed, forged, keyless]) w.close()
    })
  })
})
