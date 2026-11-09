import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserType, LaunchOptions } from '@playwright/test'

/** A deterministic microphone for the four-device media journey. The native
 * fake input exercises MicPipeline without a second Web Audio source whose
 * output clock or lifetime can itself leave the test sending silence. */
export async function nativeMicrophoneBrowser(type: BrowserType, options: LaunchOptions = {}) {
  if (type.name() !== 'chromium') throw new Error('The native microphone fixture requires Chromium.')
  const directory = await mkdtemp(join(tmpdir(), 'kithmoot-native-mic-'))
  try {
    const path = join(directory, 'microphone.wav')
    // Owned, artificial speech-like harmonics; no recording or external file.
    const rate = 48_000, samples = rate * 8
    const bytes = Buffer.alloc(44 + samples * 2)
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
    bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
    bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
    let phase = 0
    for (let i = 0; i < samples; i++) {
      const time = i / rate
      phase += 2 * Math.PI * (145 + 30 * Math.sin(2 * Math.PI * 2 * time)) / rate
      let wave = 0
      for (let harmonic = 1; harmonic <= 8; harmonic++) wave += Math.sin(harmonic * phase) / harmonic ** 1.4
      const envelope = 0.55 + 0.4 * Math.sin(2 * Math.PI * 4.5 * time)
      bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, wave * envelope * 0.35)) * 32767), 44 + i * 2)
    }
    await writeFile(path, bytes)
    const browser = await type.launch({ ...options, args: [...(options.args ?? []), `--use-file-for-fake-audio-capture=${path}`] })
    return {
      browser,
      async close() { try { await browser.close() } finally { await rm(directory, { recursive: true, force: true }) } },
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Bounded failure evidence: decoded samples differ from merely receiving RTP. */
export const audioFailureDiagnostics = async () => {
  const track = (value: MediaStreamTrack) => ({ id: value.id, enabled: value.enabled, muted: value.muted, state: value.readyState })
  const pcs = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []
  const peers = []
  for (const [index, pc] of pcs.slice(-12).entries()) {
    const audio: Record<string, unknown>[] = []
    let stats: RTCStatsReport
    try { stats = await pc.getStats() }
    catch (error) { peers.push({ index, state: pc.connectionState, error: String(error) }); continue }
    stats.forEach(report => {
      if (report.kind !== 'audio' || !['inbound-rtp', 'outbound-rtp', 'media-source', 'media-playout'].includes(report.type) || audio.length >= 16) return
      const fields: Record<string, unknown> = {}
      for (const key of ['type', 'kind', 'trackIdentifier', 'packetsReceived', 'packetsDiscarded', 'bytesReceived', 'packetsSent', 'bytesSent', 'totalAudioEnergy', 'totalSamplesReceived', 'totalSamplesDuration', 'totalSamplesCount', 'jitterBufferEmittedCount', 'jitterBufferDelay']) {
        if (report[key] !== undefined) fields[key] = report[key]
      }
      audio.push(fields)
    })
    peers.push({ index, state: pc.connectionState, senders: pc.getSenders().filter(sender => sender.track?.kind === 'audio').map(sender => track(sender.track!)), receivers: pc.getReceivers().filter(receiver => receiver.track.kind === 'audio').map(receiver => track(receiver.track)), audio })
  }
  return {
    elements: [...document.querySelectorAll('audio')].filter(el => el.srcObject instanceof MediaStream).slice(0, 24).map(el => ({
      connected: el.isConnected, paused: el.paused, muted: el.muted, volume: el.volume, time: el.currentTime,
      readyState: el.readyState, networkState: el.networkState,
      error: el.error ? { code: el.error.code, message: el.error.message } : undefined,
      tracks: (el.srcObject as MediaStream).getAudioTracks().map(track),
    })),
    peers,
  }
}
