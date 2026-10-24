import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createRealtimeAudioMixer, REALTIME_AUDIO_MIXER_UNAVAILABLE, REALTIME_AUDIO_SOURCE_INVALID } from './playback.js'

class Track {
  readyState = 'live'
  stop = vi.fn(() => { this.readyState = 'ended' })
}
class Stream {
  constructor(readonly tracks: Track[] = []) {}
  getTracks() { return this.tracks }
  getAudioTracks() { return this.tracks }
}
function stream(track = new Track()): MediaStream { return new Stream([track]) as unknown as MediaStream }
interface TestNode { connect: Mock; disconnect: Mock }
interface TestParameter { value: number; setTargetAtTime: Mock }
interface TestGain extends TestNode { gain: TestParameter }
interface TestAnalyser extends TestNode {
  fftSize: number
  samples: number
  getFloatTimeDomainData: Mock<(array: Float32Array) => void>
}
function setup() {
  const nodes: TestNode[] = [], gains: TestGain[]= [], analysers: TestAnalyser[] = []
  const contexts: Context[] = [], output = new Track(), constructions: (AudioContextOptions & { sinkId?: unknown })[] = []
  let rejectNullSink = false, running = true, failSource = false
  function node(): TestNode {
    const value = { connect: vi.fn(), disconnect: vi.fn() }; nodes.push(value); return value
  }
  function parameter(value: number): TestParameter { return { value, setTargetAtTime: vi.fn() } }
  function gain(): TestGain { const value = { ...node(), gain: parameter(1) }; gains.push(value); return value }
  function analyser(): TestAnalyser {
    const value: TestAnalyser = { ...node(), fftSize: 2048, samples: .125,
      getFloatTimeDomainData: vi.fn((array: Float32Array): void => { array.fill(value.samples) }) }
    analysers.push(value); return value
  }
  class Context {
    currentTime = 42
    state = running ? 'running' : 'suspended'
    close = vi.fn(async () => { this.state = 'closed' })
    resume = vi.fn(async () => {})
    createGain = gain
    createAnalyser = analyser
    sourceStreams: MediaStream[] = []
    createMediaStreamSource = vi.fn((stream: MediaStream) => {
      if (failSource) throw new Error('private source device detail')
      this.sourceStreams.push(stream); return node()
    })
    createMediaStreamDestination = vi.fn(() => ({ ...node(), stream: new Stream([output]) }))
    limiter = { ...node(), threshold: parameter(0), knee: parameter(0), ratio: parameter(1), attack: parameter(1), release: parameter(1) }
    createDynamicsCompressor = vi.fn(() => this.limiter)
    constructor(options: AudioContextOptions & { sinkId?: unknown }) {
      constructions.push(options)
      if (rejectNullSink && options.sinkId) throw new TypeError('Unsupported sink')
      contexts.push(this)
    }
  }
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('MediaStream', Stream)
  return { contexts, nodes, gains, analysers, output, constructions,
    rejectNullSink: () => { rejectNullSink = true }, failResume: () => { running = false }, failSource: () => { failSource = true } }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('conference audio mixer', () => {
  it('uses one processing context and one exported stream for independently controlled sources', async () => {
    const b = setup(), first = new Track(), second = new Track(), mixer = await createRealtimeAudioMixer()
    mixer.attach('first', stream(first)); mixer.attach('second', stream(second), .5)
    expect(b.contexts).toHaveLength(1)
    expect(b.constructions).toEqual([{ sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } }])
    expect(mixer.stream.getAudioTracks()).toEqual([b.output])
    expect(b.contexts[0].sourceStreams.map(s => s.getAudioTracks())).toEqual([[first], [second]])
    expect(mixer.stats()).toEqual({ sources: 2, maxSources: 32, masterGain: 1 / Math.sqrt(1.25), closed: false })
    expect(b.gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1 / Math.sqrt(1.25), 42, .02)
    expect(b.contexts[0].limiter.ratio.value).toBe(20)
    expect(b.contexts[0].limiter.threshold.value).toBe(-3)
    mixer.close(); expect(first.stop).not.toHaveBeenCalled(); expect(second.stop).not.toHaveBeenCalled()
  })

  it('bounds source admission and refuses duplicate IDs, invalid gains and empty or ended sources', async () => {
    const b = setup(), mixer = await createRealtimeAudioMixer({ maxSources: 2 }), ended = new Track(); ended.readyState = 'ended'
    expect(() => mixer.attach('', stream())).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    expect(() => mixer.attach(' ', stream())).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    expect(() => mixer.attach('x'.repeat(129), stream())).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    for (const gain of [-1, NaN, Infinity, 1.01]) expect(() => mixer.attach('bad', stream(), gain)).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    expect(() => mixer.attach('empty', new Stream() as unknown as MediaStream)).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    expect(() => mixer.attach('ended', stream(ended))).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    expect(b.contexts[0].createMediaStreamSource).not.toHaveBeenCalled()
    mixer.attach('first', stream())
    expect(() => mixer.attach('first', stream())).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    mixer.attach('second', stream())
    expect(() => mixer.attach('third', stream())).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    expect(mixer.stats().sources).toBe(2)
    mixer.close()
  })

  it('updates participant gain smoothly and recalculates headroom without counting muted inputs', async () => {
    const b = setup(), mixer = await createRealtimeAudioMixer()
    mixer.attach('first', stream()); mixer.attach('second', stream())
    expect(mixer.stats().masterGain).toBe(1 / Math.sqrt(2))
    mixer.setGain('first', 0)
    expect(b.gains[1].gain.setTargetAtTime).toHaveBeenCalledWith(0, 42, .02)
    expect(mixer.stats().masterGain).toBe(1)
    expect(() => mixer.setGain('unknown', .5)).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    expect(() => mixer.setGain('first', Infinity)).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    mixer.setGain('first', 1)
    expect(mixer.stats().masterGain).toBe(1 / Math.sqrt(2))
    mixer.detach('second'); expect(mixer.stats().masterGain).toBe(1)
    mixer.close()
  })

  it('reports individual post-gain PCM levels without storing recordings', async () => {
    const b = setup(), mixer = await createRealtimeAudioMixer()
    mixer.attach('quiet', stream()); mixer.attach('speaking', stream())
    b.analysers[0].samples = 0; b.analysers[1].samples = .25
    expect(mixer.sampleRms('quiet')).toBe(0)
    expect(mixer.sampleRms('speaking')).toBe(.25)
    expect(b.analysers.map(a => a.fftSize)).toEqual([512, 512])
    expect(mixer.sampleRms('unknown')).toBe(0)
    mixer.detach('speaking'); expect(mixer.sampleRms('speaking')).toBe(0)
    mixer.close(); expect(mixer.sampleRms('quiet')).toBe(0)
  })

  it('detaches graphs once, reuses freed capacity and stops only the owned output on close', async () => {
    const b = setup(), mixer = await createRealtimeAudioMixer({ maxSources: 1 }), caller = new Track()
    mixer.attach('first', stream(caller)); const source = b.nodes.at(-3)!, level = b.gains[1], analyser = b.analysers[0]
    mixer.detach('first'); mixer.detach('first')
    expect(source.disconnect).toHaveBeenCalledOnce(); expect(level.disconnect).toHaveBeenCalledOnce(); expect(analyser.disconnect).toHaveBeenCalledOnce()
    expect(caller.stop).not.toHaveBeenCalled()
    mixer.attach('replacement', stream(caller)); mixer.close(); mixer.close()
    expect(mixer.stats()).toEqual({ sources: 0, maxSources: 1, masterGain: 1, closed: true })
    expect(b.output.stop).toHaveBeenCalledOnce(); expect(b.contexts[0].close).toHaveBeenCalledOnce()
    expect(caller.stop).not.toHaveBeenCalled()
    expect(() => mixer.attach('later', stream())).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
  })

  it('falls back to an ordinary processing context where null sinks are unsupported', async () => {
    const b = setup(); b.rejectNullSink()
    const mixer = await createRealtimeAudioMixer()
    expect(b.constructions).toHaveLength(2)
    expect(b.constructions[1]).toEqual({ sampleRate: 48000, latencyHint: 'interactive' })
    mixer.attach('first', stream()); expect(mixer.stats().sources).toBe(1)
    mixer.close()
  })

  it('rejects invalid capacity before allocating a context and closes failed startup resources', async () => {
    const b = setup()
    for (const maxSources of [0, 33, 1.5, NaN]) await expect(createRealtimeAudioMixer({ maxSources })).rejects.toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    expect(b.contexts).toHaveLength(0)
    b.failResume()
    await expect(createRealtimeAudioMixer()).rejects.toThrow(REALTIME_AUDIO_MIXER_UNAVAILABLE)
    expect(b.output.stop).toHaveBeenCalledOnce(); expect(b.contexts[0].close).toHaveBeenCalledOnce()
  })

  it('does not retain failed source creation or leak private exception details', async () => {
    const b = setup(), mixer = await createRealtimeAudioMixer(); b.failSource()
    expect(() => mixer.attach('source', stream())).toThrow(REALTIME_AUDIO_SOURCE_INVALID)
    expect(mixer.stats().sources).toBe(0)
    mixer.close()
  })
})
