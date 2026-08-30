import { test, expect } from '@playwright/test'

/**
 * Peer assist, measured in a real browser rather than reasoned about.
 *
 * Three questions the unit tests cannot answer, because all three are
 * questions about what a browser actually does with encoded media:
 *
 * 1. **Which path carried it.** Read from `getStats` - the selected candidate
 *    pair on every leg, and the type of the candidates at each end of it -
 *    rather than inferred from a log line saying which rung the mesh chose.
 * 2. **What happens when the volunteer vanishes.** The normal case, not the
 *    edge case: somebody shuts a laptop mid-sentence and the pair they were
 *    carrying has to keep talking through somebody else.
 * 3. **What it costs the person carrying it**, in bytes and in their own
 *    call's frame rate.
 *
 * ## What this harness can and cannot prove
 *
 * Every connection here is loopback inside one page, so:
 *
 * - **Candidate types are real.** ICE genuinely selects a pair and genuinely
 *   reports what kind of candidates it chose, which is what makes "a member of
 *   the room carried this, not a TURN server" a measurement rather than a
 *   claim. No TURN server is configured in this harness, so the assertion
 *   that no leg used a relay candidate is a check that the topology is what
 *   it looks like, not a comparison against TURN. `test/turn-relay.spec.ts`
 *   is the other half of that, against the real deployment.
 * - **Frame movement is real.** Encoded frames really are taken off one
 *   connection and put onto another, and the far end really decodes them.
 * - **Bandwidth is not constrained.** Loopback has no bottleneck, so what the
 *   cost measurement below shows is the CPU and encoder cost of relaying, not
 *   what carrying three pairs would do to a domestic uplink. That figure is
 *   arithmetic - two streams up and two down per pair - and it is stated as
 *   arithmetic rather than dressed up as a measurement.
 * - **Escalation latency is not measured.** The switch from one volunteer to
 *   the next is driven by the test rather than by `Mesh`, so the gap recorded
 *   here is the media path's, not the signalling's. The decision to escalate,
 *   and the four routes to it, are covered in `src/mesh-assist.test.ts`.
 */

/** The page-side toolkit, as seen from the test. Type only: it is erased
 *  before the surrounding function is stringified into the page. */
interface AssistKit {
  painting(style: 'busy' | 'flat', fps: number): MediaStreamTrack
  connect(a: RTCPeerConnection, b: RTCPeerConnection): Promise<void>
  drain(pc: RTCPeerConnection, sink: (frame: { data: ArrayBuffer }) => void): void
  pump(sender: RTCRtpSender, next: () => ArrayBuffer | null): void
  path(pc: RTCPeerConnection): Promise<PathEvidence | null>
  inbound(pc: RTCPeerConnection): Promise<{ framesDecoded: number; bytesReceived: number }>
  outbound(pc: RTCPeerConnection): Promise<{
    bytesSent: number
    framesPerSecond: number
    framesEncoded: number
    qualityLimitationReason: string
  }>
  wait(ms: number): Promise<void>
}

/** What one connection's ICE actually chose. */
interface PathEvidence {
  localType: string
  remoteType: string
  state: string
  bytesSent: number
  bytesReceived: number
}

interface PathResult {
  error: string | null
  aToVolunteer: PathEvidence | null
  volunteerToB: PathEvidence | null
  relayedFrames: number
  relayedBytes: number
  decodedAtFarEnd: number
  bytesAtFarEnd: number
  decodedAtVolunteer: number
  connectionsAtA: number
  connectionsAtB: number
}

interface VanishResult {
  error: string | null
  beforeFromFirst: number
  afterFromFirst: number
  beforeFromSecond: number
  afterFromSecond: number
  gapMs: number
  firstRelayed: number
  secondRelayed: number
}

interface CostResult {
  error: string | null
  idleOwnBps: number
  busyOwnBps: number
  idleOwnFps: number
  busyOwnFps: number
  idleQualityLimitation: string
  busyQualityLimitation: string
  relayBytesIn: number
  relayBytesOut: number
  relaySeconds: number
  pairsCarried: number
  farEndDecoded: number[]
}

/**
 * The page-side toolkit, injected once per test.
 *
 * Kept as a string rather than as imported helpers because everything here
 * runs inside the page, where this file's module graph does not exist.
 */
const TOOLKIT = `
  window.__assist = {
    painting(style, fps) {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      const ctx = canvas.getContext('2d')
      let t = 0
      const timer = setInterval(() => {
        t += 7
        ctx.fillStyle = style === 'busy' ? 'hsl(' + (t % 360) + ',80%,50%)' : '#111'
        ctx.fillRect(0, 0, 320, 240)
        if (style === 'busy') {
          ctx.fillStyle = '#fff'
          ctx.fillRect((t * 3) % 320, (t * 5) % 240, 60, 60)
        }
      }, 1000 / fps)
      const track = canvas.captureStream(fps).getVideoTracks()[0]
      track.addEventListener('ended', () => clearInterval(timer))
      return track
    },

    async connect(a, b) {
      // A candidate is held until the far side holds the description it
      // belongs to; an addIceCandidate made before that rejects, and on
      // loopback host candidates gather faster than an offer is applied.
      // Peer buffers for the same reason (finding I3).
      const pending = new Map([[a, []], [b, []]])
      const forward = (to) => (e) => {
        if (!e.candidate) return
        if (to.remoteDescription) void to.addIceCandidate(e.candidate)
        else pending.get(to).push(e.candidate)
      }
      const drain = async (pc) => {
        for (const candidate of pending.get(pc).splice(0)) await pc.addIceCandidate(candidate)
      }
      a.onicecandidate = forward(b)
      b.onicecandidate = forward(a)
      const offer = await a.createOffer()
      await a.setLocalDescription(offer)
      await b.setRemoteDescription(offer)
      await drain(b)
      const answer = await b.createAnswer()
      await b.setLocalDescription(answer)
      await a.setRemoteDescription(answer)
      await drain(a)
      await new Promise((resolve) => {
        if (a.connectionState === 'connected') return resolve()
        a.addEventListener('connectionstatechange', () => {
          if (a.connectionState === 'connected') resolve()
        })
        setTimeout(resolve, 15000)
      })
    },

    /** Take a receiver's encoded frames and never enqueue them onwards, so
     *  nothing on this side ever decodes them. */
    drain(pc, sink) {
      pc.ontrack = (event) => {
        const streams = event.receiver.createEncodedStreams()
        void streams.readable
          .pipeTo(new WritableStream({ write(frame) { sink(frame) } }))
          .catch(() => {})
      }
    },

    /** Replace a sender's own encoded frames with whatever \`next\` hands back.
     *  Claimed before negotiation, which is the browser's rule, not ours. */
    pump(sender, next) {
      const streams = sender.createEncodedStreams()
      void streams.readable
        .pipeThrough(new TransformStream({
          transform(frame, controller) {
            const carried = next()
            if (!carried) return
            frame.data = carried
            controller.enqueue(frame)
          },
        }))
        .pipeTo(streams.writable)
        .catch(() => {})
    },

    /** What ICE actually chose for this connection, and how much went over it. */
    async path(pc) {
      const report = await pc.getStats()
      const byId = new Map()
      report.forEach((stat, id) => byId.set(id, stat))
      let pair = null
      for (const stat of byId.values()) {
        if (stat.type === 'transport' && stat.selectedCandidatePairId) {
          pair = byId.get(stat.selectedCandidatePairId) ?? pair
        }
      }
      if (!pair) {
        for (const stat of byId.values()) {
          if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) pair = stat
        }
      }
      if (!pair) return null
      const local = byId.get(pair.localCandidateId)
      const remote = byId.get(pair.remoteCandidateId)
      return {
        localType: (local && local.candidateType) || 'unknown',
        remoteType: (remote && remote.candidateType) || 'unknown',
        state: pair.state || 'unknown',
        bytesSent: pair.bytesSent || 0,
        bytesReceived: pair.bytesReceived || 0,
      }
    },

    async inbound(pc) {
      let framesDecoded = 0
      let bytesReceived = 0
      ;(await pc.getStats()).forEach((stat) => {
        if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
          framesDecoded += stat.framesDecoded || 0
          bytesReceived += stat.bytesReceived || 0
        }
      })
      return { framesDecoded, bytesReceived }
    },

    async outbound(pc) {
      let bytesSent = 0
      let framesPerSecond = 0
      let framesEncoded = 0
      let qualityLimitationReason = 'none'
      ;(await pc.getStats()).forEach((stat) => {
        if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
          bytesSent += stat.bytesSent || 0
          framesEncoded += stat.framesEncoded || 0
          if (stat.framesPerSecond) framesPerSecond = stat.framesPerSecond
          if (stat.qualityLimitationReason) qualityLimitationReason = stat.qualityLimitationReason
        }
      })
      return { bytesSent, framesPerSecond, framesEncoded, qualityLimitationReason }
    },

    wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) },
  }
`

test.describe('peer assist in a real browser', () => {
  test.beforeEach(async ({ page, context }) => {
    // Every connection here meets on host candidates, on one machine. A page
    // without camera or microphone permission is handed those as mDNS names
    // rather than addresses, and resolving an mDNS name between two
    // connections in one browser is a property of the machine, not of peer
    // assist - it stopped working here with a VPN up. A page that holds
    // media permission is given real addresses, which is what a volunteer
    // has anyway: it is in the call. See relay-capability.spec.ts.
    await context.grantPermissions(['camera', 'microphone'])
    await page.goto('./')
    await page.evaluate(TOOLKIT)
  })

  test('a pair connects through a member of the room, and getStats says which path carried it', async ({
    page,
  }) => {
    const result = await page.evaluate<PathResult>(async () => {
      const kit = (window as unknown as { __assist: AssistKit }).__assist

      let error: string | null = null
      // A and B cannot reach each other. V is a member of the room who can
      // reach both, which is the entire situation peer assist exists for.
      const pcA = new RTCPeerConnection()
      const pcVfromA = new RTCPeerConnection()
      const pcVtoB = new RTCPeerConnection()
      const pcB = new RTCPeerConnection()

      const source = kit.painting('busy', 15)
      const clock = kit.painting('flat', 15)
      const queue: ArrayBuffer[] = []
      let relayedFrames = 0
      let relayedBytes = 0

      kit.drain(pcVfromA, (frame) => {
        queue.push(frame.data.slice(0))
        if (queue.length > 60) queue.shift()
      })

      pcA.addTrack(source, new MediaStream([source]))
      const relaySender = pcVtoB.addTrack(clock, new MediaStream([clock]))
      try {
        kit.pump(relaySender, () => {
          const next = queue.shift()
          if (!next) return null
          relayedFrames += 1
          relayedBytes += next.byteLength
          return next
        })
      } catch (err) {
        error = String(err)
      }

      await kit.connect(pcA, pcVfromA)
      await kit.connect(pcVtoB, pcB)
      await kit.wait(8000)

      const aToVolunteer = await kit.path(pcA)
      const volunteerToB = await kit.path(pcB)
      const farEnd = await kit.inbound(pcB)
      const atVolunteer = await kit.inbound(pcVfromA)

      // A holds one connection and it goes to the volunteer; B likewise. If
      // either held two, the pair could have talked directly and the
      // measurement below would be about the wrong thing.
      const connectionsAtA = pcA.getSenders().length + pcA.getReceivers().length
      const connectionsAtB = pcB.getSenders().length + pcB.getReceivers().length

      for (const pc of [pcA, pcVfromA, pcVtoB, pcB]) pc.close()
      source.stop()
      clock.stop()

      return {
        error,
        aToVolunteer,
        volunteerToB,
        relayedFrames,
        relayedBytes,
        decodedAtFarEnd: farEnd.framesDecoded,
        bytesAtFarEnd: farEnd.bytesReceived,
        decodedAtVolunteer: atVolunteer.framesDecoded,
        connectionsAtA,
        connectionsAtB,
      }
    })

    expect(result.error).toBeNull()

    // The path, read from the browser rather than assumed from the topology.
    expect(result.aToVolunteer).not.toBeNull()
    expect(result.volunteerToB).not.toBeNull()
    expect(result.aToVolunteer!.state).toBe('succeeded')
    expect(result.volunteerToB!.state).toBe('succeeded')
    // Not a relay candidate at either end of either leg: no TURN server
    // carried any part of this. A member of the room did.
    for (const leg of [result.aToVolunteer!, result.volunteerToB!]) {
      expect(leg.localType).not.toBe('relay')
      expect(leg.remoteType).not.toBe('relay')
    }

    // And the media genuinely made the trip.
    expect(result.relayedFrames).toBeGreaterThan(20)
    expect(result.decodedAtFarEnd).toBeGreaterThan(20)
    expect(result.bytesAtFarEnd).toBeGreaterThan(result.relayedBytes * 0.5)
    // The volunteer moved all of that without decoding any of it.
    expect(result.decodedAtVolunteer).toBe(0)

    // eslint-disable-next-line no-console
    console.log('assist path:', JSON.stringify(result))
  })

  test('the pair keeps talking when the volunteer shuts its laptop mid-call', async ({ page }) => {
    test.setTimeout(120_000)

    const result = await page.evaluate<VanishResult>(async () => {
      const kit = (window as unknown as { __assist: AssistKit }).__assist

      let error: string | null = null
      const source = kit.painting('busy', 15)
      const clockOne = kit.painting('flat', 15)
      const clockTwo = kit.painting('flat', 15)

      // Both volunteers are already connected to both ends, because that is
      // the only way a volunteer is ever chosen: assist opens no new
      // connection, it starts forwarding between two a member already has.
      const pcA1 = new RTCPeerConnection()
      const pcV1fromA = new RTCPeerConnection()
      const pcV1toB = new RTCPeerConnection()
      const pcB1 = new RTCPeerConnection()
      const pcA2 = new RTCPeerConnection()
      const pcV2fromA = new RTCPeerConnection()
      const pcV2toB = new RTCPeerConnection()
      const pcB2 = new RTCPeerConnection()

      const queueOne: ArrayBuffer[] = []
      const queueTwo: ArrayBuffer[] = []
      // The second volunteer is connected and idle, exactly as a member of the
      // room who has volunteered but not been chosen is idle.
      let carrying: 'first' | 'second' = 'first'
      let firstRelayed = 0
      let secondRelayed = 0

      kit.drain(pcV1fromA, (frame) => {
        if (carrying !== 'first') return
        queueOne.push(frame.data.slice(0))
        if (queueOne.length > 60) queueOne.shift()
      })
      kit.drain(pcV2fromA, (frame) => {
        if (carrying !== 'second') return
        queueTwo.push(frame.data.slice(0))
        if (queueTwo.length > 60) queueTwo.shift()
      })

      pcA1.addTrack(source, new MediaStream([source]))
      pcA2.addTrack(source, new MediaStream([source]))
      const senderOne = pcV1toB.addTrack(clockOne, new MediaStream([clockOne]))
      const senderTwo = pcV2toB.addTrack(clockTwo, new MediaStream([clockTwo]))

      try {
        kit.pump(senderOne, () => {
          const next = queueOne.shift()
          if (!next) return null
          firstRelayed += 1
          return next
        })
        kit.pump(senderTwo, () => {
          const next = queueTwo.shift()
          if (!next) return null
          secondRelayed += 1
          return next
        })
      } catch (err) {
        error = String(err)
      }

      await kit.connect(pcA1, pcV1fromA)
      await kit.connect(pcV1toB, pcB1)
      await kit.connect(pcA2, pcV2fromA)
      await kit.connect(pcV2toB, pcB2)

      // The first volunteer carries the pair for a while.
      await kit.wait(8000)
      const beforeFirst = await kit.inbound(pcB1)
      const beforeSecond = await kit.inbound(pcB2)

      // The laptop shuts. Not a polite withdrawal: the connections simply
      // stop existing, which is what a closed lid or a killed tab looks like
      // from the outside.
      const vanishedAt = performance.now()
      pcV1fromA.close()
      pcV1toB.close()
      carrying = 'second'

      // The next volunteer down the ranking picks it up. Both ends already
      // had this connection open, so there is nothing to negotiate.
      let firstFrameAt = 0
      while (performance.now() - vanishedAt < 20000) {
        await kit.wait(250)
        const seen = await kit.inbound(pcB2)
        if (seen.framesDecoded > beforeSecond.framesDecoded + 5) {
          firstFrameAt = performance.now()
          break
        }
      }
      await kit.wait(4000)

      const afterFirst = await kit.inbound(pcB1)
      const afterSecond = await kit.inbound(pcB2)

      for (const pc of [pcA1, pcV1fromA, pcV1toB, pcB1, pcA2, pcV2fromA, pcV2toB, pcB2]) pc.close()
      source.stop()
      clockOne.stop()
      clockTwo.stop()

      return {
        error,
        beforeFromFirst: beforeFirst.framesDecoded,
        afterFromFirst: afterFirst.framesDecoded,
        beforeFromSecond: beforeSecond.framesDecoded,
        afterFromSecond: afterSecond.framesDecoded,
        gapMs: firstFrameAt === 0 ? -1 : Math.round(firstFrameAt - vanishedAt),
        firstRelayed,
        secondRelayed,
      }
    })

    expect(result.error).toBeNull()

    // The first volunteer was genuinely carrying the pair.
    expect(result.firstRelayed).toBeGreaterThan(20)
    expect(result.beforeFromFirst).toBeGreaterThan(20)
    // And the second was genuinely idle before it was needed, so what follows
    // is a handover rather than two relays running all along.
    expect(result.beforeFromSecond).toBeLessThan(5)

    // The laptop shut, and that path stopped.
    expect(result.afterFromFirst - result.beforeFromFirst).toBeLessThan(5)

    // The pair kept talking, through somebody else.
    expect(result.gapMs).toBeGreaterThan(-1)
    expect(result.secondRelayed).toBeGreaterThan(20)
    expect(result.afterFromSecond).toBeGreaterThan(result.beforeFromSecond + 20)

    // eslint-disable-next-line no-console
    console.log('volunteer vanished:', JSON.stringify(result))
  })

  test('carrying two pairs costs the volunteer bandwidth, and its own call keeps its frame rate', async ({
    page,
  }) => {
    test.setTimeout(120_000)

    const result = await page.evaluate<CostResult>(async () => {
      const kit = (window as unknown as { __assist: AssistKit }).__assist

      let error: string | null = null
      const PAIRS = 2
      /** How long each measurement window runs for, idle and busy alike. */
      const WINDOW_SECONDS = 8

      // The volunteer's own call: it is in the room like everybody else, with
      // its own camera going to somebody. This is what must not be ruined.
      const own = kit.painting('busy', 15)
      const pcVown = new RTCPeerConnection()
      const pcPartner = new RTCPeerConnection()
      pcVown.addTrack(own, new MediaStream([own]))

      interface Carried {
        source: MediaStreamTrack
        clock: MediaStreamTrack
        pcSource: RTCPeerConnection
        pcIn: RTCPeerConnection
        pcOut: RTCPeerConnection
        pcFar: RTCPeerConnection
        queue: ArrayBuffer[]
        bytesIn: number
        bytesOut: number
      }

      const carried: Carried[] = []
      for (let i = 0; i < PAIRS; i += 1) {
        const source = kit.painting('busy', 15)
        const clock = kit.painting('flat', 15)
        const entry: Carried = {
          source,
          clock,
          pcSource: new RTCPeerConnection(),
          pcIn: new RTCPeerConnection(),
          pcOut: new RTCPeerConnection(),
          pcFar: new RTCPeerConnection(),
          queue: [],
          bytesIn: 0,
          bytesOut: 0,
        }
        carried.push(entry)
      }

      let relaying = false
      for (const entry of carried) {
        kit.drain(entry.pcIn, (frame) => {
          if (!relaying) return
          entry.bytesIn += frame.data.byteLength
          entry.queue.push(frame.data.slice(0))
          if (entry.queue.length > 60) entry.queue.shift()
        })
        entry.pcSource.addTrack(entry.source, new MediaStream([entry.source]))
        const sender = entry.pcOut.addTrack(entry.clock, new MediaStream([entry.clock]))
        try {
          kit.pump(sender, () => {
            const next = entry.queue.shift()
            if (!next) return null
            entry.bytesOut += next.byteLength
            return next
          })
        } catch (err) {
          error = String(err)
        }
      }

      await kit.connect(pcVown, pcPartner)
      for (const entry of carried) {
        await kit.connect(entry.pcSource, entry.pcIn)
        await kit.connect(entry.pcOut, entry.pcFar)
      }

      // Baseline: everything connected, nothing being carried. The volunteer
      // is simply in a call, which is where it starts.
      await kit.wait(6000)
      const idleStart = await kit.outbound(pcVown)
      await kit.wait(WINDOW_SECONDS * 1000)
      const idleEnd = await kit.outbound(pcVown)

      // Now it carries two pairs.
      relaying = true
      await kit.wait(6000)
      const busyStart = await kit.outbound(pcVown)
      const relayStart = performance.now()
      const carriedInStart = carried.reduce((sum, entry) => sum + entry.bytesIn, 0)
      const carriedOutStart = carried.reduce((sum, entry) => sum + entry.bytesOut, 0)
      await kit.wait(WINDOW_SECONDS * 1000)
      const busyEnd = await kit.outbound(pcVown)
      const relaySeconds = (performance.now() - relayStart) / 1000
      const relayBytesIn = carried.reduce((sum, entry) => sum + entry.bytesIn, 0) - carriedInStart
      const relayBytesOut = carried.reduce((sum, entry) => sum + entry.bytesOut, 0) - carriedOutStart

      const farEndDecoded: number[] = []
      for (const entry of carried) farEndDecoded.push((await kit.inbound(entry.pcFar)).framesDecoded)

      pcVown.close()
      pcPartner.close()
      own.stop()
      for (const entry of carried) {
        for (const pc of [entry.pcSource, entry.pcIn, entry.pcOut, entry.pcFar]) pc.close()
        entry.source.stop()
        entry.clock.stop()
      }

      return {
        error,
        idleOwnBps: Math.round(((idleEnd.bytesSent - idleStart.bytesSent) * 8) / WINDOW_SECONDS),
        busyOwnBps: Math.round(((busyEnd.bytesSent - busyStart.bytesSent) * 8) / WINDOW_SECONDS),
        idleOwnFps: idleEnd.framesPerSecond,
        busyOwnFps: busyEnd.framesPerSecond,
        idleQualityLimitation: idleEnd.qualityLimitationReason,
        busyQualityLimitation: busyEnd.qualityLimitationReason,
        relayBytesIn,
        relayBytesOut,
        relaySeconds,
        pairsCarried: PAIRS,
        farEndDecoded,
      }
    })

    expect(result.error).toBeNull()

    // It really was carrying both pairs, and both far ends really saw them.
    expect(result.relayBytesOut).toBeGreaterThan(0)
    for (const decoded of result.farEndDecoded) expect(decoded).toBeGreaterThan(20)

    // Its own call did not stop, and did not lose most of its frame rate for
    // it. A loopback harness cannot congest an uplink, so this is the CPU and
    // encoder half of the cost - stated as that, and no more.
    expect(result.busyOwnBps).toBeGreaterThan(0)
    expect(result.busyOwnFps).toBeGreaterThan(result.idleOwnFps * 0.6)

    // eslint-disable-next-line no-console
    console.log('assist cost:', JSON.stringify(result))
  })
})
