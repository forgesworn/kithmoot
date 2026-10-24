/// <reference path="../app/src/desktop.d.ts" />
// Generated media only. No OS camera, microphone or screen is captured here.
import { RealtimeCallAdapter, loadRealtimeRuntime, connectRealtimeService, newPublication, discoverRealtimeServices,
  createRealtimeAudioMixer, type RealtimeAudioMixer, type SourceBinding, type LocalSource, type TransportRuntime, type QueueFactory } from '../src/realtime/index.js'
import { BrowserShare } from '../app/src/browser-share.js'
import { createMeshTransport } from './realtime-mesh.js'

let runtime: TransportRuntime, queueFactory: QueueFactory
let pool: InstanceType<TransportRuntime['RelayPool']>, session: InstanceType<TransportRuntime['RelaySwarmSession']>
let adapter: RealtimeCallAdapter | undefined, connection: Awaited<ReturnType<typeof connectRealtimeService>> | undefined
let local: LocalSource[] = [], received: { source: SourceBinding; video: HTMLVideoElement; audio: HTMLAudioElement }[] = []
let own: { stop(): void }[] = [], share: BrowserShare | undefined
let ice: { iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy }
let mixer: RealtimeAudioMixer, audioSink: HTMLAudioElement
let mesh: Awaited<ReturnType<typeof createMeshTransport>> | undefined
let dropEvery = 0, incoming = 0, injectedDrops = 0
const errors: string[] = []
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('')
const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!, n => parseInt(n, 16))
function error(): void { errors.push('Realtime pipeline error') }
function binding(role: 'camera' | 'screen'): SourceBinding {
  return { sender: session.pubkey, role, video: newPublication(session.pubkey), audio: newPublication(session.pubkey) }
}
function markerChecksum(stamp: number): number {
  // CRC-8 over low/high timestamp bytes. Unlike a byte XOR, this also rejects
  // two flipped bits in the same column of the timestamp and check bytes.
  let check = 0xa5
  for (const byte of [stamp & 0xff, (stamp >>> 8) & 0xff]) {
    check ^= byte
    for (let bit = 0; bit < 8; bit++) check = ((check << 1) ^ (check & 0x80 ? 0x07 : 0)) & 0xff
  }
  return check
}
function generated(index: number): MediaStream {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
  const context = canvas.getContext('2d')!
  let frame = 0
  const paint = () => {
    context.fillStyle = `hsl(${index * 43},70%,40%)`; context.fillRect(0, 0, 320, 180)
    context.fillStyle = '#ffffff'; context.fillRect((frame++ * 7) % 300, 10, 20, 15)
    context.fillStyle = '#000000'; context.fillText(String(index), 10, 80)
    const stamp = Math.floor(Date.now() / 10) % 65536
    const marker = stamp | (markerChecksum(stamp) << 16)
    for (let bit = 0; bit < 24; bit++) { context.fillStyle = marker & (1 << bit) ? '#ffffff' : '#000000'; context.fillRect(bit * 12, 160, 10, 10) }
  }
  paint(); const timer = setInterval(paint, 50)
  const stream = canvas.captureStream(15), audio = new AudioContext({ sampleRate: 48_000 })
  const oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination()
  oscillator.frequency.value = 440 + index * 80; gain.gain.value = .1; oscillator.connect(gain); gain.connect(destination); oscillator.start()
  stream.addTrack(destination.stream.getAudioTracks()[0]!)
  own.push({ stop: () => { clearInterval(timer); oscillator.stop(); stream.getTracks().forEach(t => t.stop()); void audio.close() } })
  return stream
}
async function boot(options: { base: string; relay: string; namespace: string; index: number; ice: typeof ice }) {
  const loaded = await loadRealtimeRuntime(new URL(options.base)); runtime = loaded.transport; queueFactory = loaded.queueFactory; ice = options.ice
  pool = new runtime.RelayPool([options.relay]); await pool.connect()
  session = new runtime.RelaySwarmSession({ pool, swarmId: options.namespace }); session.onSignal(event => { void event })
  session.start()
  mixer = await createRealtimeAudioMixer()
  audioSink = document.createElement('audio'); audioSink.autoplay = true; audioSink.srcObject = mixer.stream
  document.body.append(audioSink); await audioSink.play()
  local.push({ ...binding('camera'), stream: generated(options.index) })
  return describe()
}
function describe(): SourceBinding[] { return local.map(({ stream: _stream, ...description }) => description) }
async function protectedShare(): Promise<void> {
  share = new BrowserShare(() => {})
  const stream = await share.start(true)
  local.push({ ...binding('screen'), stream })
}
async function begin(options: { remote: SourceBinding[]; roomKey: string; operator?: string }) {
  adapter = await RealtimeCallAdapter.create({ roomKey: fromHex(options.roomKey), queueFactory, local, remote: options.remote,
    config: { width: 320, height: 180, framerate: 12, videoBitrate: 200_000, audioBitrate: 24_000 }, onError: error,
    onKeyFrameRequired: id => connection?.requestKeyFrame(id), onRemoteStream: (source, stream) => {
      const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.autoplay = true; video.width = 240; video.height = 135; video.srcObject = new MediaStream(stream.getVideoTracks())
      document.body.append(video); void video.play().catch(error)
      mixer.attach(source.video!.id, stream)
      received.push({ source, video, audio: audioSink })
    } })
  if (options.operator) await replace(options.operator)
  else mesh = await createMeshTransport({ runtime, session, remotePubkeys: [...new Set(options.remote.map(v => v.sender))],
    ice: { iceServers: [], iceTransportPolicy: 'all' }, onDatagram: bytes => adapter!.receive(bytes) })
}
async function startMesh() { await mesh!.start(); adapter!.replaceForwarder(mesh!) }
async function replace(operator: string) {
  const publications = local.flatMap(v => [v.video!.id, v.audio!.id])
  const subscriptions = received.flatMap(v => [v.source.video!.id, v.source.audio!.id])
  const next = await connectRealtimeService({ runtime, session, operator, publications, subscriptions, ice,
    onDatagram: bytes => { if (dropEvery && ++incoming % dropEvery === 0) { injectedDrops++; return }; adapter!.receive(bytes) },
    onKeyFrameRequired: id => adapter!.requestKeyFrame(id), timeoutMs: 30_000 })
  connection = next; adapter!.replaceForwarder(next)
}
async function metrics() {
  const media = received.map(row => {
    const rms = mixer.sampleRms(row.source.video!.id)
    let pixels: number[] = [], latencyMs: number | null = null, markerValid = false
    if (row.video.videoWidth) {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
      const ctx = canvas.getContext('2d')!; ctx.drawImage(row.video, 0, 0, 320, 180)
      pixels = [...ctx.getImageData(160, 90, 1, 1).data, ...ctx.getImageData(20, 20, 1, 1).data]
      if (row.source.role === 'camera') {
        let marker = 0, clearBits = true
        for (let bit = 0; bit < 24; bit++) {
          const sample = ctx.getImageData(bit * 12 + 4, 164, 3, 3).data
          let brightness = 0
          for (let pixel = 0; pixel < sample.length; pixel += 4) brightness += sample[pixel]! + sample[pixel + 1]! + sample[pixel + 2]!
          brightness /= 27
          if (brightness > 170) marker |= 1 << bit
          else if (brightness >= 85) clearBits = false
        }
        const stamp = marker & 0xffff
        markerValid = clearBits && (marker >>> 16) === markerChecksum(stamp)
        // A damaged high timestamp bit can look like several minutes of
        // delay. Invalid or ambiguous markers are missing observations.
        if (markerValid) latencyMs = (Date.now() - stamp * 10) % 655360
      }
    }
    return { role: row.source.role, rms, videoTime: row.video.currentTime, audioTime: row.audio.currentTime,
      width: row.video.videoWidth, pixels, latencyMs, markerValid, audible: !row.audio.paused && !row.audio.muted,
      audioError: row.audio.error?.code ?? null, videoError: row.video.error?.code ?? null }
  })
  const report = connection ? await connection.pc.getStats() : new Map()
  const stats: Record<string, any>[] = []; report.forEach((v: Record<string, any>) => stats.push(v))
  // The transport names its actual selected pair. A controlled ICE agent's
  // candidate-pair report need not expose nominated=true on every sample.
  const selectedId = stats.find(v => v.type === 'transport' && v.selectedCandidatePairId)?.selectedCandidatePairId
  const pair = selectedId ? report.get(selectedId) : stats.find(v => v.type === 'candidate-pair' && v.nominated && v.state === 'succeeded')
  const localCandidate = pair ? report.get(pair.localCandidateId) : undefined, remoteCandidate = pair ? report.get(pair.remoteCandidateId) : undefined
  return { adapter: adapter?.snapshot(), transport: mesh?.snapshot() ?? connection?.snapshot(), media, errors, injectedDrops,
    candidate: { local: localCandidate?.candidateType, remote: remoteCandidate?.candidateType, relayProtocol: localCandidate?.relayProtocol,
      roundTripTimeMs: typeof pair?.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null },
    sourceTracksLive: local.every(s => s.stream.getTracks().every(t => t.readyState === 'live')) }
}
async function shutdown() {
  adapter?.close(); connection?.close(); mesh?.close(); share?.stop(); session?.close(); pool?.close()
  const callerTracksPreserved = local.filter(s => s.role === 'camera').every(s => s.stream.getTracks().every(t => t.readyState === 'live'))
  for (const row of received) { row.video.pause(); row.audio.pause(); row.video.srcObject = row.audio.srcObject = null }
  mixer.close()
  own.forEach(v => v.stop()); own = []; received = []; local = []
  return { callerTracksPreserved }
}
Object.assign(window, { realtimeFixture: { boot, describe, protectedShare, begin, replace, metrics, shutdown, startMesh,
  setLoss(every: number) { dropEvery = every } } })
document.querySelector('#share')!.addEventListener('click', () => { void protectedShare().catch(error) })
