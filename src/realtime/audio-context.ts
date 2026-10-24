/** A PCM processing graph whose exported MediaStream is played elsewhere. */
export function createRealtimeProcessingAudioContext(): AudioContext {
  const options: AudioContextOptions = { sampleRate: 48_000, latencyHint: 'interactive' }
  // Keep the processing clock running without opening a speaker device for
  // every participant. Older browsers can use the ordinary processing graph.
  try { return new AudioContext({ ...options, sinkId: { type: 'none' } } as AudioContextOptions) }
  catch { return new AudioContext(options) }
}
