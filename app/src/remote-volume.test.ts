import { describe, it, expect, vi } from 'vitest'
import { RemoteVolume } from './remote-volume.js'

/**
 * A fake Web Audio graph, in the same shape as `speaking-monitor.test.ts`'s -
 * it records what got connected to what, so a test can tell "routed to the
 * destination" from "built and left dangling", which is the one mistake
 * that makes a gain path fail silently.
 */
function fakeContext() {
  const connections: string[] = []
  const disconnected: string[] = []

  const node = (name: string) => ({
    name,
    connect: vi.fn((to: { name: string }) => {
      connections.push(`${name}->${to.name}`)
    }),
    disconnect: vi.fn(() => {
      disconnected.push(name)
    }),
  })

  const destination = { name: 'destination' }
  const gainNode = { ...node('gain'), gain: { value: 1 } }

  const context = {
    state: 'running' as AudioContextState,
    destination,
    createMediaStreamSource: vi.fn(() => node('source')),
    createGain: vi.fn(() => gainNode),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }

  return { context, gainNode, connections, disconnected }
}

// The module builds `new MediaStream([track])`, which node does not have.
// It hands it straight to the fake context, which ignores it.
vi.stubGlobal(
  'MediaStream',
  class {
    constructor(public tracks: unknown[]) {}
  },
)

function track(id = 't1'): MediaStreamTrack {
  return { id, kind: 'audio' } as MediaStreamTrack
}

/** A stand-in `<audio>` element: just the two properties this module ever
 *  touches on one. */
function audioEl(): HTMLAudioElement {
  return { muted: false, volume: 1 } as unknown as HTMLAudioElement
}

function volumeWith(fake: ReturnType<typeof fakeContext>, isIOS = false): RemoteVolume {
  return new RemoteVolume({ createContext: () => fake.context as unknown as AudioContext, isIOS })
}

describe('RemoteVolume', () => {
  it('uses .volume alone for an ordinary level, opening no context at all', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    const el = audioEl()
    v.apply('k1', el, track(), 0.5, false)
    expect(el.volume).toBe(0.5)
    expect(el.muted).toBe(false)
    expect(fake.context.createGain).not.toHaveBeenCalled()
  })

  it('never opens the gain path for the untouched 100% level, even on iOS', () => {
    const fake = fakeContext()
    const v = volumeWith(fake, true)
    const el = audioEl()
    v.apply('k1', el, track(), 1, false)
    expect(fake.context.createGain).not.toHaveBeenCalled()
    expect(el.muted).toBe(false)
    expect(el.volume).toBe(1)
  })

  it('routes a level above 100% through a gain node into the destination', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    const el = audioEl()
    v.apply('k1', el, track(), 2, false)
    expect(fake.connections).toEqual(['source->gain', 'gain->destination'])
    expect(fake.gainNode.gain.value).toBe(2)
    // The decode sink only, never the speaker, while the gain path is live.
    expect(el.muted).toBe(true)
  })

  it('routes any changed level on iOS through gain, since .volume is read-only there', () => {
    const fake = fakeContext()
    const v = volumeWith(fake, true)
    const el = audioEl()
    v.apply('k1', el, track(), 0.5, false)
    expect(fake.context.createGain).toHaveBeenCalledTimes(1)
    expect(fake.gainNode.gain.value).toBe(0.5)
    expect(el.muted).toBe(true)
  })

  it('two devices of one person both take the same level', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    const deviceA = audioEl()
    const deviceB = audioEl()
    v.apply('dev1|t1', deviceA, track('a'), 0.5, false)
    v.apply('dev2|t2', deviceB, track('b'), 0.5, false)
    expect(deviceA.volume).toBe(0.5)
    expect(deviceB.volume).toBe(0.5)
  })

  it('a third person is untouched by another person’s level', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    const ada = audioEl()
    const cara = audioEl()
    v.apply('ada|t1', ada, track('a'), 0.5, false)
    v.apply('cara|t2', cara, track('c'), 1, false)
    expect(ada.volume).toBe(0.5)
    expect(cara.volume).toBe(1)
    expect(cara.muted).toBe(false)
  })

  it('a rule-muted device stays silent at 200%, on the gain path', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    const el = audioEl()
    v.apply('k1', el, track(), 2, true)
    expect(el.muted).toBe(true)
    expect(fake.gainNode.gain.value).toBe(0)
  })

  it('a rule-muted device stays silent under 100%, on the plain element path', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    const el = audioEl()
    v.apply('k1', el, track(), 0.5, true)
    expect(el.muted).toBe(true)
  })

  it('re-applying the same track under the same gain decision does not rebuild the graph', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    const el = audioEl()
    const t = track()
    v.apply('k1', el, t, 1.5, false)
    v.apply('k1', el, t, 1.8, false)
    expect(fake.context.createGain).toHaveBeenCalledTimes(1)
    expect(fake.gainNode.gain.value).toBe(1.8)
  })

  it('a track handed over by a renegotiation rebuilds the graph and keeps the level', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    const el = audioEl()
    v.apply('k1', el, track('a'), 1.5, false)
    v.apply('k1', el, track('b'), 1.5, false)
    expect(fake.context.createGain).toHaveBeenCalledTimes(2)
    expect(fake.disconnected).toContain('source')
    expect(fake.gainNode.gain.value).toBe(1.5)
  })

  it('crossing back under 100% tears down the gain path and returns to .volume', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    const el = audioEl()
    const t = track()
    v.apply('k1', el, t, 1.5, false)
    expect(el.muted).toBe(true)
    v.apply('k1', el, t, 0.5, false)
    expect(fake.disconnected).toEqual(expect.arrayContaining(['source', 'gain']))
    expect(el.muted).toBe(false)
    expect(el.volume).toBe(0.5)
  })

  it('falling back when Web Audio throws caps at .volume and reports it', () => {
    const fake = fakeContext()
    fake.context.createGain.mockImplementation(() => {
      throw new Error('no Web Audio here')
    })
    const v = volumeWith(fake)
    const el = audioEl()
    v.apply('k1', el, track(), 2, false)
    expect(v.gainAvailable).toBe(false)
    expect(el.muted).toBe(false)
    expect(el.volume).toBe(1)
  })

  it('detach disconnects the nodes it opened', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    v.apply('k1', audioEl(), track(), 2, false)
    v.detach('k1')
    expect(fake.disconnected).toEqual(expect.arrayContaining(['source', 'gain']))
  })

  it('detach on a plain-path key is a harmless no-op', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    v.apply('k1', audioEl(), track(), 0.5, false)
    expect(() => v.detach('k1')).not.toThrow()
  })

  it('retain drops the keys that have left', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    v.apply('k1', audioEl(), track('a'), 2, false)
    v.apply('k2', audioEl(), track('b'), 2, false)
    v.retain(['k1'])
    expect(fake.disconnected).toEqual(expect.arrayContaining(['source', 'gain']))
    fake.context.createGain.mockClear()
    // k1 survives with its graph intact - reapplying it must not rebuild.
    v.apply('k1', audioEl(), track('a'), 2, false)
  })

  it('resumes a context that was created suspended', () => {
    const fake = fakeContext()
    fake.context.state = 'suspended'
    volumeWith(fake).resume()
    expect(fake.context.resume).toHaveBeenCalled()
  })

  it('a context that cannot be created leaves the gain path unavailable', () => {
    const v = new RemoteVolume({
      createContext: () => {
        throw new Error('no AudioContext here')
      },
    })
    v.resume()
    expect(v.gainAvailable).toBe(false)
  })

  it('survives a disconnect that throws on an already-closed context', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    v.apply('k1', audioEl(), track(), 2, false)
    fake.gainNode.disconnect.mockImplementation(() => {
      throw new Error('context closed')
    })
    expect(() => v.detach('k1')).not.toThrow()
  })

  it('close tears down every route and closes the context', () => {
    const fake = fakeContext()
    const v = volumeWith(fake)
    v.apply('k1', audioEl(), track(), 2, false)
    v.close()
    expect(fake.context.close).toHaveBeenCalled()
  })
})
