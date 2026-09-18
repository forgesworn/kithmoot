/**
 * The capability gate and the per-pair controller: step S6 of the call
 * reliability design, covering §2.3's compatibility rules and §3.4's "this
 * controller replaces the route timers for the direct and turn rungs".
 *
 * The question every case here asks is a version of the same one: *which*
 * watchdog owns this pair. Getting it wrong is not a cosmetic problem - two
 * watchdogs on one pair race to decide what to do about a slow negotiation,
 * and the loser's decision is a teardown of the connection that was about to
 * work. That is half of what the route ladder did to real calls.
 */

import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Mesh } from './mesh.js'
import type { MeshSession } from './mesh.js'

import { unwrapSignalEvent, wrapSignal } from './signal.js'
import type { SignalBody } from './signal.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import type { ParticipantView } from './session.js'
import type { ForwarderRef, TrackRole } from './types.js'

const ROOM_ID = 'room-1'

function device(): { sk: Uint8Array; pub: string } {
  const sk = generateSecretKey()
  return { sk, pub: getPublicKey(sk) }
}

class FakeSession implements MeshSession {
  #views: ParticipantView[] = []
  #listeners = new Set<(views: ParticipantView[]) => void>()
  participants(): ParticipantView[] {
    return this.#views
  }
  onChange(cb: (views: ParticipantView[]) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }
  setViews(views: ParticipantView[]): void {
    this.#views = views
    for (const listener of this.#listeners) listener(views)
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const track = (id: string, kind: 'audio' | 'video' = 'audio') => ({ id, kind }) as MediaStreamTrack

interface Harness {
  mesh: Mesh
  session: FakeSession
  factory: ReturnType<typeof createFakeFactory>
  relay: SimRelay
  local: { sk: Uint8Array; pub: string }
  remote: { sk: Uint8Array; pub: string }
  /** Put a roster on the wire for the remote device, with or without a
   *  profile claim, and with whichever slots it claims are live. */
  roster: (callProfile?: number, advertised?: TrackRole[]) => void
  /** Deliver one signal from the remote device to this mesh. */
  fromRemote: (body: Omit<SignalBody, 'roomId'>) => void
  /** Everything this mesh has addressed to the remote device, unwrapped as
   *  that device would. */
  toRemote: () => SignalBody[]
}

function harness(
  options: {
    callProfile?: 1 | 2
    routeTimeoutMs?: number
    exhaustedRetryMs?: number
    forwarders?: ForwarderRef[]
    uplink?: () => { uplinkBps: number; perPeerBps: number } | null
    forwarderMedia?: () => boolean
    pairHealth?: Record<string, unknown>
    onDiagnostic?: (event: unknown) => void
  } = {},
): Harness {
  const session = new FakeSession()
  const factory = createFakeFactory()
  const relay = new SimRelay()
  const local = device()
  const remote = device()
  const remoteParticipant = device().pub
  const mesh = new Mesh({
    session,
    factory,
    localDevice: local.pub,
    localParticipant: device().pub,
    deviceSk: local.sk,
    transport: new SimTransport(relay),
    roomId: ROOM_ID,
    callProfile: options.callProfile,
    routeTimeoutMs: options.routeTimeoutMs,
    exhaustedRetryMs: options.exhaustedRetryMs,
    forwarders: options.forwarders,
    uplink: options.uplink,
    forwarderMedia: options.forwarderMedia,
    pairHealth: options.pairHealth as never,
    forwarderMediaPipeline: options.forwarderMedia
      ? { rekey: () => true, protectSender: () => true, protectReceiver: () => true }
      : undefined,
    onDiagnostic: options.onDiagnostic as never,
  })
  return {
    mesh,
    session,
    factory,
    relay,
    local,
    remote,
    roster: (callProfile?: number, advertised: TrackRole[] = []) => {
      const view: ParticipantView = {
        participant: remoteParticipant,
        devices: [remote.pub],
        tracks: advertised.map((role) => ({ device: remote.pub, role, trackId: `${role}-remote` })),
      }
      if (callProfile !== undefined) view.callProfiles = { [remote.pub]: callProfile }
      session.setViews([view])
    },
    fromRemote: (body) =>
      relay.publish(wrapSignal({ ...body, roomId: ROOM_ID } as SignalBody, { senderSk: remote.sk, recipientPubkey: local.pub })),
    toRemote: () =>
      relay.published
        .map((event) => unwrapSignalEvent(event, { recipientSk: remote.sk, roomId: ROOM_ID }))
        .filter((s): s is NonNullable<typeof s> => s !== null && s.from === local.pub)
        .map((s) => s.body),
  }
}

/** Four `addTransceiver` calls, and nothing else, is what a profile-2
 *  connection does first. A profile-1 one never opens an empty m-line. */
const slotted = (pc: { calls: { method: string }[] }) => pc.calls.filter((c) => c.method === 'addTransceiver').length === 4

describe('the capability gate (§2.3)', () => {
  it('reads the far end\'s profile off the roster, and needs both sides to say 2', async () => {
    for (const [mine, theirs, want] of [
      [1, 2, false],
      [2, undefined, false],
      [2, 1, false],
      [2, 2, true],
    ] as const) {
      const h = harness({ callProfile: mine })
      h.roster(theirs)
      h.mesh.publish([track('mic-1')])
      await settle()
      expect(slotted(h.factory.instances[0]!), `local ${mine} -> far ${theirs}`).toBe(want)
      h.mesh.close()
    }
  })

  it('admits a pair on a signal carrying a generation, before the roster catches up', async () => {
    // A far end that has just reloaded into a profile-2 build speaks it a
    // heartbeat before its roster entry says so. Answering that offer with a
    // profile-1 peer would throw away the slot map it carries.
    const h = harness({ callProfile: 2 })
    h.roster(1)
    h.mesh.publish([track('mic-1')])
    await settle()
    expect(slotted(h.factory.instances[0]!), 'the roster said profile 1, so the first peer is profile 1').toBe(false)

    h.fromRemote({ type: 'offer', sdp: 'their-offer', gen: 1, conn: 'aaaaaaaaaaaaaaaa', seq: 1, slots: { 0: 'mic', 1: 'camera', 2: 'screen', 3: 'screen-audio' } })
    await settle()

    // A controller exists for a profile-2 pair and for no other kind, so its
    // presence is the gate's answer. The connection itself is deliberately
    // not asserted on here: the polite side of a generation-opening glare
    // correctly creates no transceivers of its own, which is amendment A1.
    expect(h.mesh.pairDiagnostics().map((p) => p.device), 'the pair was not upgraded on the evidence of a generation').toEqual([h.remote.pub])
    h.mesh.close()
  })

  it('downgrades a pair whose far end answers in profile-1 shape, and never upgrades it again', async () => {
    const h = harness({ callProfile: 2 })
    h.roster(2)
    h.mesh.publish([track('mic-1')])
    await settle()
    const first = h.factory.to(h.remote.pub)!
    expect(slotted(first)).toBe(true)

    // What a far end reloading into an old build looks like: an offer with
    // no generation on it at all.
    h.fromRemote({ type: 'offer', sdp: 'old-offer' })
    await settle()
    const second = h.factory.to(h.remote.pub)!
    expect(second, 'the connection was not replaced').not.toBe(first)
    expect(slotted(second), 'a downgraded pair must go back to negotiating track by track').toBe(false)

    // And the roster keeps arriving saying profile 2 - a heartbeat must not
    // flip the pair back.
    h.roster(2)
    await settle()
    expect(slotted(h.factory.to(h.remote.pub)!)).toBe(false)
    h.mesh.close()
  })

  it('a downgraded pair is not talked back up by a stray generation either', async () => {
    const h = harness({ callProfile: 2 })
    h.roster(2)
    h.mesh.publish([track('mic-1')])
    await settle()
    h.fromRemote({ type: 'offer', sdp: 'old-offer' })
    await settle()
    expect(slotted(h.factory.to(h.remote.pub)!)).toBe(false)

    h.fromRemote({ type: 'offer', sdp: 'their-offer', gen: 7, conn: 'bbbbbbbbbbbbbbbb', seq: 1, slots: { 0: 'mic', 1: 'camera', 2: 'screen', 3: 'screen-audio' } })
    await settle()
    expect(slotted(h.factory.to(h.remote.pub)!), 'a downgraded pair flipped back on one signal').toBe(false)
    h.mesh.close()
  })
})

describe('the per-pair controller owns the direct and turn rungs (§3.4)', () => {
  it('arms no route timer for a profile-2 pair, and still arms one for a profile-1 pair', async () => {
    vi.useFakeTimers()
    try {
      for (const [profile, wantEscalation] of [
        [2, false],
        [1, true],
      ] as const) {
        const h = harness({ callProfile: 2, routeTimeoutMs: 5_000 })
        h.roster(profile)
        h.mesh.publish([track('mic-1')])
        await vi.advanceTimersByTimeAsync(0)
        const first = h.factory.to(h.remote.pub)!

        // Long past the rung's whole budget, with nothing ever answering.
        await vi.advanceTimersByTimeAsync(20_000)

        // A route timer that fired would have closed this connection and
        // opened the next rung's.
        expect(first.closed, `profile ${profile}`).toBe(wantEscalation)
        h.mesh.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('rests and then tries the pair again from the top, instead of the exhausted retry timer', async () => {
    vi.useFakeTimers()
    try {
      const seen: { kind?: string; detail?: string }[] = []
      const h = harness({ callProfile: 2, exhaustedRetryMs: 5_000, onDiagnostic: (e) => seen.push(e as never) })
      h.roster(2)
      h.mesh.publish([track('mic-1')])
      await vi.advanceTimersByTimeAsync(0)
      const first = h.factory.to(h.remote.pub)!

      // Walk the pair off the end of the ladder the only way a profile-2
      // pair can get there: the connection itself reporting failed, one rung
      // at a time. Nothing here is a timer expiring, which is the point.
      for (let rung = 0; rung < 4; rung++) {
        const pc = h.factory.to(h.remote.pub)
        if (!pc) break
        pc.connectionState = 'failed'
        pc.onconnectionstatechange?.()
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(first.closed).toBe(true)
      expect(h.mesh.routes.get(h.remote.pub)?.exhausted, 'the pair never ran out of rungs').toBe(true)
      expect(seen.some((e) => e.kind === 'pair-ladder' && /resting/.test(e.detail ?? '')), 'no rest was announced').toBe(true)

      // The rest is 5s +/- 25%, so by 7s it has certainly come round, and the
      // pair is back on the top rung with a fresh connection.
      await vi.advanceTimersByTimeAsync(7_000)
      expect(h.mesh.routes.get(h.remote.pub)?.exhausted, 'the pair was left exhausted for good').toBe(false)
      expect(h.mesh.routes.get(h.remote.pub)?.tier).toBe('direct')
      expect(seen.some((e) => e.kind === 'pair-ladder' && /top rung/.test(e.detail ?? ''))).toBe(true)
      h.mesh.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the pair\'s generation and unacked depth for a bug report', async () => {
    const h = harness({ callProfile: 2 })
    h.roster(2)
    h.mesh.publish([track('mic-1')])
    await settle()

    const [pair] = h.mesh.pairDiagnostics()
    expect(pair?.device).toBe(h.remote.pub)
    expect(pair?.generation, 'the opening offer did not open a generation').toBe(1)
    expect(pair?.ladder).toBe('healthy')
    // One offer out, nothing acknowledged yet.
    expect(pair?.unacked).toBe(1)
    expect(pair?.unexpectedNegotiations).toBe(0)
    h.mesh.close()
  })

  it('makes no controller at all for a profile-1 pair', async () => {
    const h = harness({ callProfile: 2 })
    h.roster(1)
    h.mesh.publish([track('mic-1')])
    await settle()
    expect(h.mesh.pairDiagnostics()).toEqual([])
    h.mesh.close()
  })
})

describe('a forwarder carrying the room suspends the controller', () => {
  const forwarder = (): ForwarderRef => ({ pubkey: getPublicKey(generateSecretKey()), url: 'wss://forwarder.example' })

  it('suspends while forwarding is up and hands the rungs back when it fails', async () => {
    vi.useFakeTimers()
    try {
      const ref = forwarder()
      const h = harness({
        callProfile: 2,
        forwarders: [ref],
        forwarderMedia: () => true,
        // A room this device plainly cannot serve directly, so promotion is
        // the honest answer rather than a preference.
        uplink: () => ({ uplinkBps: 100_000, perPeerBps: 400_000 }),
      })
      h.roster(2)
      h.mesh.publish([track('mic-1')])
      await vi.advanceTimersByTimeAsync(0)
      expect(h.mesh.pairDiagnostics()[0]?.ladder).toBe('healthy')

      const forwarderPc = h.factory.instances.find((pc) => pc.context?.tier === 'forwarder')
      expect(forwarderPc, 'the room never tried to promote').toBeDefined()
      forwarderPc!.connectionState = 'connected'
      forwarderPc!.onconnectionstatechange?.()
      await vi.advanceTimersByTimeAsync(0)

      expect(h.mesh.forwarding).toBe('up')
      expect(h.mesh.pairDiagnostics()[0]?.ladder, 'the controller kept judging a pair with no connection').toBe('suspended')

      // The forwarder drops. A connection that was up gets an ICE restart
      // first - that is `Peer`'s own doing - so it takes a second failure
      // for the mesh to hear about it. The room is then a direct mesh again,
      // and the pair is its own watchdog again.
      forwarderPc!.connectionState = 'failed'
      forwarderPc!.onconnectionstatechange?.()
      await vi.advanceTimersByTimeAsync(0)
      forwarderPc!.onconnectionstatechange?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.mesh.forwarding).toBe('failed')
      expect(h.mesh.pairDiagnostics()[0]?.ladder).toBe('healthy')
      h.mesh.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the controller acts on what it measures (§3.4)', () => {
  /** Short enough to drive in milliseconds, in the same proportions as the
   *  real thresholds. */
  const FAST = {
    sampleMs: 500,
    graceMs: 1_000,
    deadMs: 1_000,
    rtcpDeadMs: 2_000,
    restartMs: { direct: 2_000, turn: 3_000 },
    rebuildMs: { direct: 3_000, turn: 5_000 },
  }

  /**
   * What a browser looks like once the answer has been applied: every slot
   * negotiated `sendrecv`, with a receiver on each. The mesh tests do not
   * exchange real SDP, so this is what stands in for it - and without it a
   * connection reports no `inbound-rtp` at all, which would make every case
   * here pass for the wrong reason.
   */
  function negotiated(pc: ReturnType<typeof createFakeFactory>['instances'][number]): void {
    for (const transceiver of pc.getTransceivers()) {
      transceiver.currentDirection = 'sendrecv'
      transceiver.receiver.track = { id: `remote-${transceiver.mid}`, kind: transceiver.kind } as MediaStreamTrack
    }
  }

  it('restarts ICE, then rebuilds, on a connected pair that delivers nothing', async () => {
    vi.useFakeTimers()
    try {
      const seen: { kind?: string; detail?: string }[] = []
      const h = harness({ callProfile: 2, pairHealth: FAST, onDiagnostic: (e) => seen.push(e as never) })
      // The far end says its microphone is live. Nothing ever arrives.
      h.roster(2, ['mic'])
      h.mesh.publish([track('mic-1')])
      await vi.advanceTimersByTimeAsync(0)

      const pc = h.factory.to(h.remote.pub)!
      negotiated(pc)
      pc.connectionState = 'connected'
      pc.onconnectionstatechange?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.mesh.pairDiagnostics()[0]?.ladder).toBe('healthy')

      // Inside the grace nothing is judged: a connection that has just come
      // up has not had time to key, let alone deliver.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(pc.calls.some((c) => c.method === 'restartIce'), 'judged inside its grace').toBe(false)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(pc.calls.some((c) => c.method === 'restartIce')).toBe(true)
      expect(h.mesh.pairDiagnostics()[0]?.ladder).toBe('restarting')
      expect(h.mesh.pairDiagnostics()[0]?.inbound?.mic).toBe('dead')

      // The restart did not help either, so the pair is rebuilt at the next
      // generation - a new connection, and a generation above the last.
      const generationBefore = h.mesh.pairDiagnostics()[0]!.generation
      await vi.advanceTimersByTimeAsync(3_000)
      expect(h.mesh.pairDiagnostics()[0]?.generation).toBeGreaterThan(generationBefore)
      expect(h.factory.to(h.remote.pub), 'the connection was not replaced').not.toBe(pc)
      h.mesh.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends a health signal for one dead slot and leaves the connection alone', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ callProfile: 2, pairHealth: FAST })
      h.roster(2, ['mic', 'camera'])
      h.mesh.publish([track('mic-1')])
      await vi.advanceTimersByTimeAsync(0)

      const pc = h.factory.to(h.remote.pub)!
      negotiated(pc)
      pc.connectionState = 'connected'
      pc.onconnectionstatechange?.()
      await vi.advanceTimersByTimeAsync(0)

      // The microphone slot delivers; the camera slot does not. That is one
      // slot on a transport that is plainly fine.
      const feed = async (ms: number) => {
        for (let elapsed = 0; elapsed < ms; elapsed += FAST.sampleMs) {
          // Packets in, and RTCP coming back for what we send: this
          // transport is working, which is what makes the camera's silence a
          // slot problem rather than a pair problem.
          pc.scriptStats('0', { packetsReceived: 50, roundTripTimeMeasurements: 1 })
          pc.advanceStatsClock(FAST.sampleMs)
          await vi.advanceTimersByTimeAsync(FAST.sampleMs)
        }
      }
      await feed(6_000)

      expect(pc.calls.some((c) => c.method === 'restartIce'), 'one dead slot cost the whole pair').toBe(false)
      const health = h.toRemote().filter((body) => body.type === 'health')
      expect(health, 'the far end was never told its camera is arriving as nothing').not.toEqual([])
      expect(health[0]?.rx).toEqual({ camera: 'dead' })
      expect(health[0]?.gen, 'a health report belongs to a generation like every other signal').toBe(1)
      // Once per window, not once per sample: §9 budgets one signal per ten
      // seconds for this, against 120 per twenty.
      expect(health.length).toBeLessThanOrEqual(2)

      const diagnostics = h.mesh.pairDiagnostics()[0]!
      expect(diagnostics.inbound?.mic).toBe('ok')
      expect(diagnostics.inbound?.camera).toBe('dead')
      expect(diagnostics.ladder).toBe('healthy')
      h.mesh.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
