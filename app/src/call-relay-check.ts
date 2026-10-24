import { callRelayPeerConnection, callRelayServers, type CallRelay } from './call-relay.js'
import { relayOnlyIceConfiguration } from './relay-only.js'

export const CALL_RELAY_CHECK_FAILED = 'The relay test did not complete. Check the login, network and server, then try again.'

/** Two temporary relay-only connections exchange test bytes. No capture,
 * room identifiers, persistence, telemetry, raw error text or direct fallback.
 * A pass qualifies this device's data path, not a call or another network. */
export async function checkCallRelay(relay: CallRelay, signal: AbortSignal, timeoutMs = 12_000): Promise<void> {
  const peers: RTCPeerConnection[] = []
  const channels: RTCDataChannel[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectStopped: (reason: Error) => void = () => {}
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject })
  const stop = () => rejectStopped(new Error(CALL_RELAY_CHECK_FAILED))
  try {
    // Put the race handler in place before an already-aborted signal rejects.
    const attempt = async () => {
      if (signal.aborted) throw new Error(CALL_RELAY_CHECK_FAILED)
      const config = relayOnlyIceConfiguration(callRelayServers(relay))
      const a = callRelayPeerConnection(config); peers.push(a)
      const b = callRelayPeerConnection(config); peers.push(b)
      const pendingA: RTCIceCandidate[] = [], pendingB: RTCIceCandidate[] = []
      const candidate = (target: RTCPeerConnection, pending: RTCIceCandidate[], value: RTCIceCandidate | null) => {
        if (!value) return
        if (!target.remoteDescription) pending.push(value)
        else void target.addIceCandidate(value).catch(stop)
      }
      a.onicecandidate = event => candidate(b, pendingB, event.candidate)
      b.onicecandidate = event => candidate(a, pendingA, event.candidate)
      const sent = 'kithmoot-relay-check'
      const channel = a.createDataChannel('relay-check'); channels.push(channel)
      const echoed = new Promise<void>(resolve => {
        channel.onopen = () => channel.send(sent)
        channel.onmessage = event => { if (event.data === sent) resolve() }
        b.ondatachannel = event => {
          const remote = event.channel; channels.push(remote)
          remote.onmessage = message => { if (message.data === sent) remote.send(sent) }
        }
      })
      await a.setLocalDescription(await a.createOffer())
      if (signal.aborted || a.signalingState === 'closed') throw new Error()
      await b.setRemoteDescription(a.localDescription!)
      for (const value of pendingB.splice(0)) await b.addIceCandidate(value)
      await b.setLocalDescription(await b.createAnswer())
      if (signal.aborted || b.signalingState === 'closed') throw new Error()
      await a.setRemoteDescription(b.localDescription!)
      for (const value of pendingA.splice(0)) await a.addIceCandidate(value)
      // A working relay pair can exchange data while other candidates are
      // still gathering or timing out. Prove that path without waiting for
      // every network interface to finish its ICE probes.
      await echoed
      // Verify the path, not merely candidate gathering or an open socket.
      for (const pc of peers) {
        const stats = await pc.getStats()
        let relayed = false
        stats.forEach(stat => {
          if (stat.type !== 'candidate-pair' || stat.state !== 'succeeded' || !stat.nominated) return
          const local = stats.get(stat.localCandidateId), remote = stats.get(stat.remoteCandidateId)
          if (local?.candidateType === 'relay' && remote?.candidateType === 'relay' && stat.bytesReceived > 0) relayed = true
        })
        if (!relayed) throw new Error()
      }
    }
    signal.addEventListener('abort', stop, { once: true })
    timer = setTimeout(stop, timeoutMs)
    await Promise.race([attempt(), stopped])
  } catch { throw new Error(CALL_RELAY_CHECK_FAILED) }
  finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    for (const pc of peers) { pc.onicecandidate = null; pc.close() }
    for (const channel of channels) { channel.onopen = null; channel.onmessage = null; channel.close() }
  }
}
