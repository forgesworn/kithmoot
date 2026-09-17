import { test } from '@playwright/test'

/**
 * What this browser actually does with mids, receiver track ids, `a=msid` and
 * `muted`.
 *
 * Section 4 of the call reliability spec has a table of these four things per
 * engine, and until this spec ran it was memory rather than evidence. The
 * design deliberately depends on only one of them - `transceiver.mid` - and
 * deliberately depends on none of the other three, so the value here is
 * negative: it is the proof that leaning on a receiver track id or on `muted`
 * would have been leaning on something that differs per engine.
 *
 * It measures, it does not assert. A browser that reports something the table
 * did not expect is news, not a failure, and a probe that fails the run is a
 * probe people delete. The output is a markdown table per engine; paste it
 * into the spec.
 *
 * Runs on its own config (`playwright.probe.config.ts`) with no app build and
 * no server, so it costs the acceptance suite nothing:
 *
 *   npx playwright test --config playwright.probe.config.ts
 */

interface SlotReading {
  role: string
  kind: string
  offererMid: string | null
  answererMid: string | null
  midAgrees: boolean
  senderTrackId: string | null
  receiverTrackId: string | null
  receiverIdEqualsSender: boolean
  offerMsid: string | null
  msidEqualsSenderTrack: boolean
}

interface MuteReading {
  at: string
  muted: boolean | null
  note?: string
}

interface ProbeResult {
  engine: string
  connected: boolean
  iceNote: string
  slots: SlotReading[]
  afterReplaceTrack: {
    newSenderTrackId: string | null
    msidBefore: string | null
    msidAfterNoRenegotiation: string | null
    msidAfterRenegotiation: string | null
    receiverTrackIdAfter: string | null
    receiverTrackIdAfterRenegotiation: string | null
    ontrackFiredAgain: boolean
  }
  mute: MuteReading[]
  error: string | null
}

const PAGE = '<!doctype html><meta charset="utf-8"><title>rtc probe</title><body></body>'

test('what mid, receiver ids, msid and muted really do here', async ({ page, context, browserName }, testInfo) => {
  // Four connections in one page meet on host candidates, and Chromium hides
  // those behind mDNS names unless the page holds media permission - see the
  // same note in relay-capability.spec.ts. Only Chromium implements the
  // permission, so the others simply go without.
  await context.grantPermissions(['camera', 'microphone']).catch(() => {})
  // No app, no server, no port: the page is fulfilled from here, and
  // localhost keeps it a secure context so RTCPeerConnection is available.
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
  await page.goto('http://localhost:4191/probe.html')

  const result: ProbeResult = await page.evaluate(async (engine) => {
    const out: ProbeResult = {
      engine,
      connected: false,
      iceNote: '',
      slots: [],
      afterReplaceTrack: {
        newSenderTrackId: null,
        msidBefore: null,
        msidAfterNoRenegotiation: null,
        msidAfterRenegotiation: null,
        receiverTrackIdAfter: null,
        receiverTrackIdAfterRenegotiation: null,
        ontrackFiredAgain: false,
      },
      mute: [],
      error: null,
    }

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    function msidOf(sdp: string | undefined, mid: string): string | null {
      if (!sdp) return null
      for (const section of sdp.split(/^m=/m).slice(1)) {
        if (/a=mid:(\S+)/.exec(section)?.[1] !== mid) continue
        const msid = /a=msid:(\S+)[ \t]+(\S+)/.exec(section)
        return msid ? msid[2]! : null
      }
      return null
    }

    function videoTrack(): MediaStreamTrack {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 120
      const ctx = canvas.getContext('2d')!
      let frame = 0
      setInterval(() => {
        frame += 1
        ctx.fillStyle = frame % 2 ? '#c33' : '#3c3'
        ctx.fillRect(0, 0, 160, 120)
      }, 66)
      ctx.fillRect(0, 0, 160, 120)
      return (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(15).getVideoTracks()[0]!
    }

    function audioTrack(): MediaStreamTrack {
      const audio = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      const destination = audio.createMediaStreamDestination()
      const oscillator = audio.createOscillator()
      oscillator.frequency.value = 440
      oscillator.connect(destination)
      oscillator.start()
      return destination.stream.getAudioTracks()[0]!
    }

    try {
      const a = new RTCPeerConnection()
      const b = new RTCPeerConnection()
      a.onicecandidate = (event) => {
        if (event.candidate) void b.addIceCandidate(event.candidate).catch(() => {})
      }
      b.onicecandidate = (event) => {
        if (event.candidate) void a.addIceCandidate(event.candidate).catch(() => {})
      }

      const ontrackAtMid = new Map<string, { trackId: string; mutedAtOntrack: boolean }>()
      let ontrackCount = 0
      b.ontrack = (event) => {
        ontrackCount += 1
        ontrackAtMid.set(event.transceiver.mid ?? `?${ontrackCount}`, {
          trackId: event.track.id,
          mutedAtOntrack: event.track.muted,
        })
      }

      // The fixed slots of section 3.1, opened with addTransceiver and filled
      // with replaceTrack - exactly what profile 2 does.
      const roles: [string, 'audio' | 'video'][] = [
        ['mic', 'audio'],
        ['camera', 'video'],
        ['screen', 'video'],
        ['screen-audio', 'audio'],
      ]
      const slots = roles.map(([, kind]) => a.addTransceiver(kind, { direction: 'sendrecv' }))
      const mic = audioTrack()
      const camera = videoTrack()
      await slots[0]!.sender.replaceTrack(mic)
      await slots[1]!.sender.replaceTrack(camera)
      const offer = await a.createOffer()
      await a.setLocalDescription(offer)
      await b.setRemoteDescription(a.localDescription!)
      // Amendment A1: the answerer binds what the offer created rather than
      // opening its own transceivers.
      for (const transceiver of b.getTransceivers()) transceiver.direction = 'recvonly'
      const answer = await b.createAnswer()
      await b.setLocalDescription(answer)
      await a.setRemoteDescription(b.localDescription!)

      for (const [index, [role, kind]] of roles.entries()) {
        const mid = slots[index]!.mid
        const far = b.getTransceivers().find((t) => t.mid === mid)
        const senderTrackId = slots[index]!.sender.track?.id ?? null
        const receiverTrackId = far?.receiver.track?.id ?? null
        out.slots.push({
          role,
          kind,
          offererMid: mid,
          answererMid: far?.mid ?? null,
          midAgrees: mid !== null && mid === (far?.mid ?? null),
          senderTrackId,
          receiverTrackId,
          receiverIdEqualsSender: senderTrackId !== null && senderTrackId === receiverTrackId,
          offerMsid: msidOf(a.localDescription?.sdp, mid ?? ''),
          msidEqualsSenderTrack: senderTrackId !== null && senderTrackId === msidOf(a.localDescription?.sdp, mid ?? ''),
        })
      }
      // The addTrack case needs a connection of its own. On a connection that
      // already has an empty video slot, `addTrack` reuses that slot - the
      // JSEP rule about a sender that has never sent - so the msid measured
      // there would be the transceiver's minted id, not addTrack's.
      {
        const c = new RTCPeerConnection()
        const d = new RTCPeerConnection()
        const own = videoTrack()
        c.addTrack(own)
        const co = await c.createOffer()
        await c.setLocalDescription(co)
        await d.setRemoteDescription(c.localDescription!)
        const da = await d.createAnswer()
        await d.setLocalDescription(da)
        await c.setRemoteDescription(d.localDescription!)
        const mid = c.getTransceivers()[0]?.mid ?? null
        const far = d.getTransceivers().find((t) => t.mid === mid)
        const msid = msidOf(c.localDescription?.sdp, mid ?? '')
        out.slots.push({
          role: 'addTrack (own connection)',
          kind: 'video',
          offererMid: mid,
          answererMid: far?.mid ?? null,
          midAgrees: mid !== null && mid === (far?.mid ?? null),
          senderTrackId: own.id,
          receiverTrackId: far?.receiver.track?.id ?? null,
          receiverIdEqualsSender: own.id === far?.receiver.track?.id,
          offerMsid: msid,
          msidEqualsSenderTrack: own.id === msid,
        })
        c.close()
        d.close()
      }

      // --- msid and receiver id across a replaceTrack ------------------
      const cameraMid = slots[1]!.mid ?? '1'
      const farCamera = b.getTransceivers().find((t) => t.mid === cameraMid)
      out.afterReplaceTrack.msidBefore = msidOf(a.localDescription?.sdp, cameraMid)
      const replacement = videoTrack()
      out.afterReplaceTrack.newSenderTrackId = replacement.id
      const ontrackBefore = ontrackCount
      await slots[1]!.sender.replaceTrack(replacement)
      await sleep(200)
      out.afterReplaceTrack.msidAfterNoRenegotiation = msidOf(a.localDescription?.sdp, cameraMid)
      out.afterReplaceTrack.receiverTrackIdAfter = farCamera?.receiver.track?.id ?? null
      out.afterReplaceTrack.ontrackFiredAgain = ontrackCount > ontrackBefore

      const reoffer = await a.createOffer()
      await a.setLocalDescription(reoffer)
      await b.setRemoteDescription(a.localDescription!)
      const reanswer = await b.createAnswer()
      await b.setLocalDescription(reanswer)
      await a.setRemoteDescription(b.localDescription!)
      out.afterReplaceTrack.msidAfterRenegotiation = msidOf(a.localDescription?.sdp, cameraMid)
      out.afterReplaceTrack.receiverTrackIdAfterRenegotiation =
        b.getTransceivers().find((t) => t.mid === cameraMid)?.receiver.track?.id ?? null

      // --- when does a remote track say muted --------------------------
      const micMid = slots[0]!.mid ?? '0'
      const farMic = b.getTransceivers().find((t) => t.mid === micMid)
      const seen = ontrackAtMid.get(micMid)
      out.mute.push({ at: 'at ontrack, before any RTP', muted: seen?.mutedAtOntrack ?? null })

      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && a.connectionState !== 'connected') await sleep(200)
      out.connected = a.connectionState === 'connected' && b.connectionState === 'connected'
      out.iceNote = `a=${a.connectionState}/${a.iceConnectionState} b=${b.connectionState}/${b.iceConnectionState}`

      if (!out.connected) {
        out.mute.push({ at: 'RTP flowing', muted: null, note: 'ICE never connected in this harness' })
      } else {
        // Wait for packets, not for a timer.
        const flowing = Date.now() + 10_000
        let received = 0
        while (Date.now() < flowing && received === 0) {
          const report = await b.getStats()
          report.forEach((entry: Record<string, unknown>) => {
            if (entry.type === 'inbound-rtp' && entry.kind === 'audio') received = Number(entry.packetsReceived ?? 0)
          })
          if (received === 0) await sleep(250)
        }
        out.mute.push({ at: 'RTP flowing', muted: farMic?.receiver.track?.muted ?? null, note: `packets=${received}` })

        // The slot goes empty with no renegotiation. This is the case the
        // tile mapper would have to see if it trusted `muted`.
        await slots[0]!.sender.replaceTrack(null)
        let wentMuted: number | null = null
        const quiet = Date.now()
        while (Date.now() - quiet < 8_000) {
          if (farMic?.receiver.track?.muted) {
            wentMuted = Date.now() - quiet
            break
          }
          await sleep(200)
        }
        out.mute.push({
          at: 'after replaceTrack(null), no renegotiation',
          muted: farMic?.receiver.track?.muted ?? null,
          note: wentMuted === null ? 'still unmuted after 8s' : `muted after ${wentMuted}ms`,
        })

        // Now the direction actually changes, which is the transition the
        // W3C algorithm does define.
        slots[0]!.direction = 'recvonly'
        const o3 = await a.createOffer()
        await a.setLocalDescription(o3)
        await b.setRemoteDescription(a.localDescription!)
        const a3 = await b.createAnswer()
        await b.setLocalDescription(a3)
        await a.setRemoteDescription(b.localDescription!)
        await sleep(1_000)
        out.mute.push({
          at: 'after the sender renegotiates to recvonly',
          muted: farMic?.receiver.track?.muted ?? null,
          note: `far currentDirection=${farMic?.currentDirection ?? 'null'}`,
        })
      }

      a.close()
      b.close()
    } catch (error) {
      out.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    return out
  }, browserName)

  const yes = (value: boolean | null) => (value === null ? 'n/a' : value ? 'yes' : 'no')
  const lines: string[] = []
  lines.push(`### ${browserName}`)
  lines.push(`ICE: ${result.iceNote}${result.error ? ` | error: ${result.error}` : ''}`)
  lines.push('')
  lines.push('| slot | kind | offerer mid | answerer mid | mid agrees | sender track id | receiver track id | receiver id == sender | a=msid appdata | msid == sender track |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const slot of result.slots) {
    lines.push(
      `| ${slot.role} | ${slot.kind} | ${slot.offererMid ?? '-'} | ${slot.answererMid ?? '-'} | ${yes(slot.midAgrees)} | ${slot.senderTrackId ?? '-'} | ${slot.receiverTrackId ?? '-'} | ${yes(slot.receiverIdEqualsSender)} | ${slot.offerMsid ?? '-'} | ${yes(slot.msidEqualsSenderTrack)} |`,
    )
  }
  lines.push('')
  const r = result.afterReplaceTrack
  lines.push('| after replaceTrack on the camera slot | value |')
  lines.push('| --- | --- |')
  lines.push(`| new sender track id | ${r.newSenderTrackId ?? '-'} |`)
  lines.push(`| a=msid before | ${r.msidBefore ?? '-'} |`)
  lines.push(`| a=msid after, no renegotiation | ${r.msidAfterNoRenegotiation ?? '-'} |`)
  lines.push(`| a=msid after renegotiation | ${r.msidAfterRenegotiation ?? '-'} |`)
  lines.push(`| receiver track id after | ${r.receiverTrackIdAfter ?? '-'} |`)
  lines.push(`| receiver track id after renegotiation | ${r.receiverTrackIdAfterRenegotiation ?? '-'} |`)
  lines.push(`| ontrack fired again | ${yes(r.ontrackFiredAgain)} |`)
  lines.push('')
  lines.push('| remote track muted, measured at | muted | note |')
  lines.push('| --- | --- | --- |')
  for (const reading of result.mute) lines.push(`| ${reading.at} | ${yes(reading.muted)} | ${reading.note ?? ''} |`)

  const report = lines.join('\n')
  console.log(`\n${report}\n`)
  await testInfo.attach(`rtc-probe-${browserName}.md`, { body: report, contentType: 'text/markdown' })
})
