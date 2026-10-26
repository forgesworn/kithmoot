import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { issueKindredProof } from './access.js'
import { localIdentity } from './identity.js'
import { KINDS } from './kinds.js'
import { decodeRosterEvent } from './roster.js'
import { deriveRoom } from './room.js'
import { RoomSession } from './session.js'
import { wrapSignal } from './signal.js'

const NOW = 1_800_000_000
const SECRET = new Uint8Array(32).fill(93)
const ROOM_ID = deriveRoom(SECRET).roomId
const opened: RoomSession[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map(session => session.leave()))
  vi.useRealTimers()
})

describe('call admission lifetime', () => {
  it.each(['sweep', 'read', 'publication'] as const)('ends local call admission when its own proof expires on %s', async expiryCheck => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const relay = new SimRelay(), factory = createFakeFactory(), hostSk = generateSecretKey()
    const policy = { tier: 'kith' as const, admitted: [getPublicKey(hostSk)] }
    const makeMember = (expiresAt: number, withFactory = false) => {
      const identity = localIdentity(generateSecretKey())
      const session = new RoomSession({ transport: new SimTransport(relay), secret: SECRET,
        identity, deviceSk: generateSecretKey(), now: () => Math.floor(Date.now() / 1000),
        policy, proof: issueKindredProof({ hostSk, participant: identity.pubkey, tier: 'kith', roomId: ROOM_ID, expiresAt }),
        announceJitterMs: 0, ...(withFactory ? { factory } : {}),
        timing: { sweepIntervalMs: 1_000, heartbeatIntervalMs: 1_000_000 },
      })
      opened.push(session)
      return session
    }
    const local = makeMember(NOW + 5, true), remote = makeMember(NOW + 3_600)
    await local.join([], {})
    await remote.join([{ trackId: 'remote-camera', role: 'camera' }], {})
    await vi.advanceTimersByTimeAsync(0)
    const peer = factory.to(remote.device)!
    expect(peer).toBeDefined()
    peer.setConnectionState('connected')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(peer.closed).toBe(false)
    const rosterCount = relay.published.filter(event => event.kind === KINDS.ROSTER).length

    if (expiryCheck === 'sweep') await vi.advanceTimersByTimeAsync(1_000)
    else {
      vi.setSystemTime((NOW + 5) * 1000)
      if (expiryCheck === 'read') local.participants()
      else await local.advertise([{ trackId: 'expired-camera', role: 'camera' }], {})
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(peer.closed).toBe(true)
    expect(local.routes.size).toBe(0)
    expect(local.participants()).toEqual([])
    await local.advertise([{ trackId: 'expired-camera', role: 'camera' }], {})
    await vi.advanceTimersByTimeAsync(1_000)
    expect(factory.instances).toHaveLength(1)
    expect(relay.published.filter(event => event.kind === KINDS.ROSTER)).toHaveLength(rosterCount)
  })

  it.each(['sweep', 'read'] as const)('closes a connected call peer when its kindred proof expires on %s', async expiryCheck => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const presenceTtlSeconds = 2
    const relay = new SimRelay(), factory = createFakeFactory(), hostSk = generateSecretKey()
    const policy = { tier: 'kith' as const, admitted: [getPublicKey(hostSk)] }
    const makeMember = (expiresAt: number, withFactory = false) => {
      const identity = localIdentity(generateSecretKey())
      const session = new RoomSession({ transport: new SimTransport(relay), secret: SECRET,
        identity, deviceSk: generateSecretKey(), now: () => Math.floor(Date.now() / 1000),
        policy, proof: issueKindredProof({ hostSk, participant: identity.pubkey, tier: 'kith', roomId: ROOM_ID, expiresAt }),
        announceJitterMs: 0, ...(withFactory ? { factory } : {}),
        timing: { presenceTtlSeconds, sweepIntervalMs: 1_000, heartbeatIntervalMs: 1_000_000 },
      })
      opened.push(session)
      return session
    }
    const observer = makeMember(NOW + 3_600, true)
    const caller = makeMember(NOW + presenceTtlSeconds + 2)
    await observer.join([], {})
    await caller.join([{ trackId: 'caller-camera', role: 'camera' }], {})
    await vi.advanceTimersByTimeAsync(0)
    const peer = factory.to(caller.device)!
    expect(peer).toBeDefined()
    peer.setConnectionState('connected')
    expect(observer.routes.get(caller.device)?.connected).toBe(true)

    // Its media connection, rather than another heartbeat, keeps presence
    // alive beyond the TTL. That cannot extend the admission proof itself.
    await vi.advanceTimersByTimeAsync((presenceTtlSeconds + 1) * 1000)
    expect(peer.closed).toBe(false)
    expect(observer.participants().some(view => view.participant === caller.participant)).toBe(true)
    const changes = vi.fn()
    observer.onChange(() => { throw new Error('a renderer failed') })
    observer.onChange(changes)
    if (expiryCheck === 'read') {
      // A UI read can notice expiry before the next periodic sweep. The
      // removed entry still has to reach Mesh through a roster notification.
      vi.setSystemTime((NOW + presenceTtlSeconds + 2) * 1000)
      expect(observer.participants().some(view => view.participant === caller.participant)).toBe(false)
      await vi.advanceTimersByTimeAsync(0)
    } else await vi.advanceTimersByTimeAsync(1_000)
    expect(peer.closed).toBe(true)
    expect(observer.routes.has(caller.device)).toBe(false)
    expect(observer.participants().some(view => view.participant === caller.participant)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('does not reopen a removed call peer for fresh signals or its replayed roster', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const relay = new SimRelay(), factory = createFakeFactory(), authoritySk = generateSecretKey()
    const callerSk = generateSecretKey(), clock = () => Math.floor(Date.now() / 1000)
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: SECRET,
      identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), factory,
      authority: getPublicKey(authoritySk), epochSettleMs: 0, now: clock, announceJitterMs: 0 })
    const caller = new RoomSession({ transport: new SimTransport(relay), secret: SECRET,
      identity: localIdentity(generateSecretKey()), deviceSk: callerSk,
      authority: getPublicKey(authoritySk), epochSettleMs: 0, now: clock, announceJitterMs: 0 })
    opened.push(observer, caller)
    await observer.join([], {})
    await caller.join([{ trackId: 'caller-camera', role: 'camera' }], {})
    await vi.advanceTimersByTimeAsync(0)
    const peer = factory.to(caller.device)!
    expect(peer).toBeDefined()
    peer.setConnectionState('connected')
    const root = deriveRoom(SECRET)
    const oldRoster = relay.published.find(event => event.kind === KINDS.ROSTER &&
      decodeRosterEvent(event, { roomId: ROOM_ID, roomKey: root.roomKey, now: NOW })?.device === caller.device)!
    expect(oldRoster).toBeDefined()

    await observer.rekey({ authoritySk, removed: [caller.participant] })
    await vi.advanceTimersByTimeAsync(0)
    expect(peer.closed).toBe(true)
    expect(observer.routes.has(caller.device)).toBe(false)
    const instances = factory.instances.length

    relay.publish(oldRoster)
    relay.publish(wrapSignal({ type: 'offer', roomId: ROOM_ID, sdp: 'removed-caller-offer' },
      { senderSk: callerSk, recipientPubkey: observer.device }))
    relay.publish(wrapSignal({ type: 'ice', roomId: ROOM_ID, candidate: 'removed-caller-candidate' },
      { senderSk: callerSk, recipientPubkey: observer.device }))
    await vi.advanceTimersByTimeAsync(0)
    expect(factory.instances).toHaveLength(instances)
    expect(observer.routes.has(caller.device)).toBe(false)
    expect(observer.participants().some(view => view.participant === caller.participant)).toBe(false)
  })
})
