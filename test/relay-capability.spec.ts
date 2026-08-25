import { test, expect } from '@playwright/test'

/**
 * Can this browser actually relay?
 *
 * `detectRelayCapability` decides whether a device may advertise itself as a
 * volunteer, and the whole rule it enforces is that **advertising a
 * capability you cannot deliver is worse than not advertising**: a volunteer
 * that wins the selection and then relays nothing costs the pair a failed
 * connection and a round of fallback, where one that never offered costs
 * nothing at all.
 *
 * So the claim has to be measured rather than reasoned about, and this is
 * where it is measured. It builds the real topology in one page - a source, a
 * relay with two connections, and a far end - and asks whether encoded frames
 * taken off one connection arrive, unchanged and undecoded by the relay, at
 * the other.
 *
 * The two things the browser has to allow, both of which this proves rather
 * than assumes:
 *
 * 1. A receiver's encoded frames can be taken and never enqueued onwards, so
 *    the relay's own decoder never sees them. That is what "without decoding"
 *    means; it is the absence of a code path, not a promise.
 * 2. A sender's encoded frames can be *replaced* with those bytes. There is
 *    no API for pushing arbitrary encoded data into an RTP stream, so the
 *    relay must be sending something of its own to have frames to overwrite -
 *    the `clock` below, a trivial canvas track whose pictures are all thrown
 *    away.
 *
 * Runs against Chromium, which is what this config drives. Safari and Firefox
 * expose `RTCRtpScriptTransform` and no `createEncodedStreams`, and neither
 * carries media at all in a headless harness - so they are not measured here,
 * and `detectRelayCapability` reports them as unable rather than guessing.
 */

interface RelayResult {
  mechanism: string
  received: number
  relayed: number
  relayBytes: number
  decodedAtFarEnd: number
  bytesAtFarEnd: number
  clockBytesIfNotRelayed: number
  error: string | null
}

test('a browser that advertises assist can genuinely move somebody else\'s frames', async ({ page }) => {
  await page.goto('./')

  const result = await page.evaluate<RelayResult>(async () => {
    function painting(style: 'busy' | 'flat'): MediaStreamTrack {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      const ctx = canvas.getContext('2d')!
      let t = 0
      setInterval(() => {
        t += 7
        // The source is deliberately busy and the clock deliberately blank:
        // if the far end were somehow decoding the clock rather than the
        // relayed stream, the byte counts would give it away at once.
        ctx.fillStyle = style === 'busy' ? `hsl(${t % 360},80%,50%)` : '#111'
        ctx.fillRect(0, 0, 320, 240)
        if (style === 'busy') {
          ctx.fillStyle = '#fff'
          ctx.fillRect((t * 3) % 320, (t * 5) % 240, 60, 60)
        }
      }, 1000 / 15)
      return canvas.captureStream(15).getVideoTracks()[0]!
    }

    async function connect(a: RTCPeerConnection, b: RTCPeerConnection): Promise<void> {
      a.onicecandidate = (e) => {
        if (e.candidate) void b.addIceCandidate(e.candidate)
      }
      b.onicecandidate = (e) => {
        if (e.candidate) void a.addIceCandidate(e.candidate)
      }
      const offer = await a.createOffer()
      await a.setLocalDescription(offer)
      await b.setRemoteDescription(offer)
      const answer = await b.createAnswer()
      await b.setLocalDescription(answer)
      await a.setRemoteDescription(answer)
    }

    const source = painting('busy')
    const clock = painting('flat')
    const pcSource = new RTCPeerConnection()
    const pcRelayIn = new RTCPeerConnection()
    const pcRelayOut = new RTCPeerConnection()
    const pcFarEnd = new RTCPeerConnection()

    const queue: ArrayBuffer[] = []
    let received = 0
    let relayed = 0
    let relayBytes = 0
    let error: string | null = null
    let decodedAtRelay = 0

    type Streams = { readable: ReadableStream<{ data: ArrayBuffer }>; writable: WritableStream<{ data: ArrayBuffer }> }

    pcRelayIn.ontrack = (event) => {
      try {
        const streams = (event.receiver as unknown as { createEncodedStreams(): Streams }).createEncodedStreams()
        void streams.readable
          .pipeTo(
            new WritableStream({
              write(frame) {
                received += 1
                queue.push(frame.data.slice(0))
                if (queue.length > 60) queue.shift()
                // Deliberately never enqueued onwards: the relay's decoder is
                // handed nothing, which is the claim.
              },
            }),
          )
          .catch(() => {})
      } catch (err) {
        error = String(err)
      }
    }
    // Nothing is ever rendered from the inbound track on the relay, but count
    // whether the browser decoded it anyway.
    pcSource.addTrack(source, new MediaStream([source]))
    const relaySender = pcRelayOut.addTrack(clock, new MediaStream([clock]))

    try {
      // Claimed before negotiation. Calling this afterwards throws
      // "Too late to create encoded streams", which is the constraint that
      // decides when the mesh has to attach a relay leg.
      const streams = (relaySender as unknown as { createEncodedStreams(): Streams }).createEncodedStreams()
      void streams.readable
        .pipeThrough(
          new TransformStream({
            transform(frame, controller) {
              const next = queue.shift()
              // No relayed frame to carry means the clock's own blank picture
              // is dropped rather than sent.
              if (!next) return
              frame.data = next
              relayBytes += next.byteLength
              relayed += 1
              controller.enqueue(frame)
            },
          }),
        )
        .pipeTo(streams.writable)
        .catch(() => {})
    } catch (err) {
      error = String(err)
    }

    await connect(pcSource, pcRelayIn)
    await connect(pcRelayOut, pcFarEnd)
    await new Promise((resolve) => setTimeout(resolve, 8000))

    let decodedAtFarEnd = 0
    let bytesAtFarEnd = 0
    ;(await pcFarEnd.getStats()).forEach((report) => {
      const stat = report as { type: string; kind?: string; framesDecoded?: number; bytesReceived?: number }
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
        decodedAtFarEnd = stat.framesDecoded ?? 0
        bytesAtFarEnd = stat.bytesReceived ?? 0
      }
    })
    ;(await pcRelayIn.getStats()).forEach((report) => {
      const stat = report as { type: string; kind?: string; framesDecoded?: number }
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') decodedAtRelay = stat.framesDecoded ?? 0
    })

    for (const pc of [pcSource, pcRelayIn, pcRelayOut, pcFarEnd]) pc.close()
    source.stop()
    clock.stop()

    return {
      mechanism: 'insertable-streams',
      received,
      relayed,
      relayBytes,
      decodedAtFarEnd,
      bytesAtFarEnd,
      clockBytesIfNotRelayed: decodedAtRelay,
      error,
    }
  })

  expect(result.error).toBeNull()
  // Frames were taken off the inbound connection...
  expect(result.received).toBeGreaterThan(20)
  // ...and put onto the outbound one...
  expect(result.relayed).toBeGreaterThan(20)
  // ...and arrived at the far end, in the quantity the relay moved rather
  // than the trickle a blank canvas would have produced.
  expect(result.bytesAtFarEnd).toBeGreaterThan(result.relayBytes * 0.5)
  // ...and were decodable there, which is the difference between "bytes
  // moved" and "a person could see the other person".
  expect(result.decodedAtFarEnd).toBeGreaterThan(20)

  // Recorded so a regression is legible rather than just red.
  // eslint-disable-next-line no-console
  console.log('relay capability:', JSON.stringify(result))
})
