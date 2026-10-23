import type { Page } from '@playwright/test'

const errors = new WeakMap<Page, { name: string; message: string }[]>()
export function observeAutomaticCallErrors(page: Page): void {
  const entries: { name: string; message: string }[] = []
  errors.set(page, entries)
  page.on('pageerror', error => {
    entries.push({ name: error.name, message: error.message.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200) })
    if (entries.length > 20) entries.shift()
  })
}

/** Synthetic fixtures only: no candidates, SDP, credentials or packet capture.
 * Match native receiver objects to every sink, including parked elements. */
export async function automaticCallState(page: Page) {
  const snapshot = await page.evaluate(async () => {
    const state = window as unknown as { __pcs: RTCPeerConnection[]; __kithmootCollectDiagnostics?: () => Promise<string> }
    const native = []
    for (let peer = 0; peer < state.__pcs.length; peer++) {
      const pc = state.__pcs[peer]
      if (pc.connectionState === 'closed') continue
      const report = await pc.getStats()
      const description = (value: RTCSessionDescription | null) => {
        if (!value) return undefined
        return { type: value.type, sections: value.sdp.split(/\r?\nm=/).slice(1).map(section => {
          const lines = section.split(/\r?\n/)
          const mid = lines.find(line => line.startsWith('a=mid:'))?.slice(6)
          const transceiver = pc.getTransceivers().find(item => item.mid === mid)
          const trackIds = lines.filter(line => line.startsWith('a=msid:')).map(line => line.split(' ')[1])
          return { kind: lines[0].split(' ')[0], rejected: lines[0].split(' ')[1] === '0', mid,
            direction: lines.find(line => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line))?.slice(2),
            ssrcCount: new Set(lines.filter(line => line.startsWith('a=ssrc:')).map(line => line.split(' ')[0])).size,
            senderAdvertised: !!transceiver?.sender.track && trackIds.includes(transceiver.sender.track.id),
            receiverAdvertised: !!transceiver?.receiver.track && trackIds.includes(transceiver.receiver.track.id),
          }
        }) }
      }
      const stats: Record<string, unknown>[] = []
      report.forEach(stat => {
        if (!['inbound-rtp', 'outbound-rtp'].includes(stat.type)) return
        const keys = ['type', 'kind', 'bytesReceived', 'bytesSent', 'packetsReceived', 'packetsSent',
          'framesReceived', 'framesDecoded', 'framesDropped', 'framesEncoded', 'keyFramesDecoded',
          'pliCount', 'nackCount', 'totalAudioEnergy', 'decoderImplementation']
        const source = stat.mediaSourceId ? report.get(stat.mediaSourceId) : undefined
        stats.push({ ...Object.fromEntries(keys.filter(key => stat[key] !== undefined).map(key => [key, stat[key]])),
          ...(source ? { sourceFrames: source.frames, sourceFps: source.framesPerSecond, sourceWidth: source.width, sourceHeight: source.height } : {}),
          ...(stat.type === 'inbound-rtp' && stat.kind === 'video' ? { matchesReceiver: pc.getReceivers().some(receiver => receiver.track.id === stat.trackIdentifier) } : {}),
        })
      })
      native.push({ peer, connection: pc.connectionState, ice: pc.iceConnectionState,
        signalling: pc.signalingState, stats,
        local: description(pc.currentLocalDescription), remote: description(pc.currentRemoteDescription),
        receivers: pc.getTransceivers().map(transceiver => {
          const track = transceiver.receiver.track
          return { kind: track.kind, state: track.readyState, muted: track.muted, enabled: track.enabled,
            mid: transceiver.mid, direction: transceiver.currentDirection,
            preferredDirection: transceiver.direction,
            sender: transceiver.sender.track ? { kind: transceiver.sender.track.kind, state: transceiver.sender.track.readyState,
              muted: transceiver.sender.track.muted, enabled: transceiver.sender.track.enabled,
              encodings: transceiver.sender.getParameters().encodings?.map(encoding => ({ active: encoding.active })) } : undefined,
            sources: transceiver.receiver.getSynchronizationSources().length,
            sinks: [...document.querySelectorAll<HTMLMediaElement>('video,audio')]
              .filter(el => el.srcObject instanceof MediaStream && el.srcObject.getTracks().includes(track))
              .map(el => ({ tag: el.tagName, connected: el.isConnected, paused: el.paused,
                visible: el.checkVisibility(), time: el.currentTime,
                ancestors: [el, el.parentElement, el.parentElement?.parentElement]
                  .filter((node): node is HTMLElement => node instanceof HTMLElement)
                  .map(node => ({ tag: node.tagName, id: node.id, classes: node.className,
                    display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility })),
              })),
          }
        }),
      })
    }
    let diagnostic: unknown
    if (state.__kithmootCollectDiagnostics) {
      const report = JSON.parse(await state.__kithmootCollectDiagnostics())
      diagnostic = Object.fromEntries(['me', 'participants', 'routes', 'connections', 'pictures', 'sounds', 'callTimeline', 'visibility']
        .map(key => [key, report[key]]))
    }
    return { native, diagnostic }
  })
  return { ...snapshot, runtimeErrors: [...(errors.get(page) ?? [])] }
}
