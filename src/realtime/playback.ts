import { createRealtimeProcessingAudioContext } from './audio-context.js'

export const REALTIME_AUDIO_MIXER_UNAVAILABLE = 'Conference audio playback is unavailable'
export const REALTIME_AUDIO_SOURCE_INVALID = 'Invalid conference audio source'

export interface RealtimeAudioMixerOptions { maxSources?: number }
export interface RealtimeAudioMixer {
  /** Play this stream in one audio element using the listener's chosen sink. */
  readonly stream: MediaStream
  attach(id: string, stream: MediaStream, gain?: number): void
  detach(id: string): void
  setGain(id: string, gain: number): void
  /** PCM level after this participant's gain, before mixing and limiting. */
  sampleRms(id: string): number
  stats(): { sources: number; maxSources: number; masterGain: number; closed: boolean }
  close(): void
}

interface Input {
  source: MediaStreamAudioSourceNode
  gain: GainNode
  analyser: AnalyserNode
  pcm: Float32Array<ArrayBuffer>
  level: number
}

function validGain(gain: number): boolean { return Number.isFinite(gain) && gain >= 0 && gain <= 1 }
function validId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && id.trim().length > 0 && !/[\u0000-\u001f]/.test(id)
}

/** One speaker sink per listener, with bounded participant gain/level graphs.
 * The mixer neither captures media nor stops caller-owned input tracks. */
export async function createRealtimeAudioMixer(options: RealtimeAudioMixerOptions = {}): Promise<RealtimeAudioMixer> {
  const maxSources = options.maxSources ?? 32
  if (!Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > 32) throw new Error(REALTIME_AUDIO_SOURCE_INVALID)
  if (typeof AudioContext === 'undefined' || typeof MediaStream === 'undefined') throw new Error(REALTIME_AUDIO_MIXER_UNAVAILABLE)
  const inputs = new Map<string, Input>()
  let context: AudioContext | undefined, destination: MediaStreamAudioDestinationNode | undefined
  let master: GainNode | undefined, limiter: DynamicsCompressorNode | undefined
  let closed = false, normalisation = 1
  const close = () => {
    if (closed) return
    closed = true
    for (const input of inputs.values()) { input.source.disconnect(); input.gain.disconnect(); input.analyser.disconnect() }
    inputs.clear(); master?.disconnect(); limiter?.disconnect()
    for (const track of destination?.stream.getTracks() ?? []) track.stop()
    if (context) void context.close().catch(() => {})
    normalisation = 1
  }
  const normalise = () => {
    const power = [...inputs.values()].reduce((sum, input) => sum + input.level * input.level, 0)
    normalisation = 1 / Math.max(1, Math.sqrt(power))
    master!.gain.setTargetAtTime(normalisation, context!.currentTime, .02)
  }
  try {
    context = createRealtimeProcessingAudioContext()
    destination = context.createMediaStreamDestination()
    master = context.createGain(); limiter = context.createDynamicsCompressor()
    // Equal-power headroom avoids reducing one voice by 1/N. The compressor
    // handles simultaneous peaks; this is soft limiting, not a hard clipper.
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20
    limiter.attack.value = .003; limiter.release.value = .1
    master.connect(limiter); limiter.connect(destination)
    await context.resume()
    if (context.state !== 'running') throw new Error()
    return {
      stream: destination.stream,
      attach(id, stream, gain = 1) {
        if (closed || !validId(id) || !validGain(gain) || inputs.has(id) || inputs.size >= maxSources) throw new Error(REALTIME_AUDIO_SOURCE_INVALID)
        const track = stream.getAudioTracks().find(track => track.readyState === 'live')
        if (!track) throw new Error(REALTIME_AUDIO_SOURCE_INVALID)
        let source: MediaStreamAudioSourceNode | undefined, level: GainNode | undefined, analyser: AnalyserNode | undefined
        try {
          // Bind one explicit live track. Additional caller tracks are not
          // silently mixed or selected by MediaStream's track sort order.
          source = context!.createMediaStreamSource(new MediaStream([track]))
          level = context!.createGain(); level.gain.value = gain
          analyser = context!.createAnalyser(); analyser.fftSize = 512
          source.connect(level); level.connect(analyser); analyser.connect(master!)
          inputs.set(id, { source, gain: level, analyser, pcm: new Float32Array(512), level: gain })
          normalise()
        } catch {
          source?.disconnect(); level?.disconnect(); analyser?.disconnect()
          inputs.delete(id)
          throw new Error(REALTIME_AUDIO_SOURCE_INVALID)
        }
      },
      detach(id) {
        const input = inputs.get(id)
        if (!input || closed) return
        inputs.delete(id); input.source.disconnect(); input.gain.disconnect(); input.analyser.disconnect()
        normalise()
      },
      setGain(id, gain) {
        const input = inputs.get(id)
        if (closed || !input || !validGain(gain)) throw new Error(REALTIME_AUDIO_SOURCE_INVALID)
        input.level = gain; input.gain.gain.setTargetAtTime(gain, context!.currentTime, .02); normalise()
      },
      sampleRms(id) {
        const input = inputs.get(id)
        if (closed || !input) return 0
        input.analyser.getFloatTimeDomainData(input.pcm)
        let energy = 0
        for (const sample of input.pcm) energy += sample * sample
        return Math.sqrt(energy / input.pcm.length)
      },
      stats: () => ({ sources: inputs.size, maxSources, masterGain: normalisation, closed }),
      close,
    }
  } catch { close(); throw new Error(REALTIME_AUDIO_MIXER_UNAVAILABLE) }
}
