import { describe, it, expect, vi } from 'vitest'
import { SpeakingMonitor } from './speaking-monitor.js'
import { SPEAKING } from '../../src/index.js'

/**
 * A fake Web Audio graph.
 *
 * Records what was connected to what, so the test can assert the analyser
 * actually reaches a destination - the one mistake that makes a speaking
 * indicator fail silently, because an unpulled analyser answers with the
 * buffer's initial 128s, which reads as perfect silence for ever.
 */
function fakeContext() {
  const connections: string[] = []
  const disconnected: string[] = []
  let level = 128 // silence, in byte time-domain terms

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
  const analyser = {
    ...node('analyser'),
    fftSize: 2048,
    getByteTimeDomainData: vi.fn((bytes: Uint8Array) => {
      // A square wave at ±level, which is what a real analyser would report
      // for a steady tone of that amplitude.
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 2 === 0 ? level : 256 - level
    }),
  }
  const gainNode = { ...node('gain'), gain: { value: 1 } }

  const context = {
    state: 'running' as AudioContextState,
    destination,
    createMediaStreamSource: vi.fn(() => node('source')),
    createAnalyser: vi.fn(() => analyser),
    createGain: vi.fn(() => gainNode),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }

  return {
    context,
    analyser,
    gainNode,
    connections,
    disconnected,
    /** 128 is silence; 255 is full scale. */
    setLevel(v: number) {
      level = v
    },
  }
}

/** Loud enough to clear SPEAKING.on comfortably. */
const LOUD = 250
const SILENT = 128

function track(id = 't1'): MediaStreamTrack {
  return { id, kind: 'audio' } as MediaStreamTrack
}

// The monitor builds `new MediaStream([track])`, which node does not have.
// It hands it straight to the fake context, which ignores it.
vi.stubGlobal(
  'MediaStream',
  class {
    constructor(public tracks: unknown[]) {}
  },
)

function monitorWith(fake: ReturnType<typeof fakeContext>, onChange?: (s: ReadonlySet<string>) => void) {
  return new SpeakingMonitor({
    createContext: () => fake.context as unknown as AudioContext,
    onChange,
  })
}

describe('SpeakingMonitor', () => {
  it('routes the analyser to a destination through a silent gain', () => {
    // The failure this prevents: Web Audio only guarantees a node runs when
    // there is a path to a destination, and an analyser with nothing
    // downstream reports silence for ever with nothing in the console.
    const fake = fakeContext()
    monitorWith(fake).watch('dev1', track())

    expect(fake.connections).toEqual(['source->analyser', 'analyser->gain', 'gain->destination'])
    // Zero, or every remote voice in the room is played a second time.
    expect(fake.gainNode.gain.value).toBe(0)
  })

  it('reports nobody speaking on a silent stream', () => {
    const fake = fakeContext()
    const m = monitorWith(fake)
    m.watch('dev1', track())
    fake.setLevel(SILENT)
    m.poll(0)
    expect(m.isSpeaking('dev1')).toBe(false)
  })

  it('reports a device speaking once it is loud', () => {
    const fake = fakeContext()
    const m = monitorWith(fake)
    m.watch('dev1', track())
    fake.setLevel(LOUD)
    m.poll(0)
    expect(m.isSpeaking('dev1')).toBe(true)
    expect([...m.speaking()]).toEqual(['dev1'])
  })

  it('goes quiet again after the hangover', () => {
    const fake = fakeContext()
    const m = monitorWith(fake)
    m.watch('dev1', track())
    fake.setLevel(LOUD)
    m.poll(0)
    fake.setLevel(SILENT)
    m.poll(10)
    expect(m.isSpeaking('dev1')).toBe(true)
    m.poll(10 + SPEAKING.hangoverMs)
    expect(m.isSpeaking('dev1')).toBe(false)
  })

  it('watching the same track twice does not rebuild the graph', () => {
    // render() runs constantly; watch() has to be free to call every time.
    const fake = fakeContext()
    const m = monitorWith(fake)
    const t = track()
    m.watch('dev1', t)
    m.watch('dev1', t)
    expect(fake.context.createAnalyser).toHaveBeenCalledTimes(1)
  })

  it('replacing the track resets the decision rather than inheriting it', () => {
    // A renegotiation hands over a new track object. The old one's last
    // state is not evidence about the new one.
    const fake = fakeContext()
    const m = monitorWith(fake)
    m.watch('dev1', track('a'))
    fake.setLevel(LOUD)
    m.poll(0)
    expect(m.isSpeaking('dev1')).toBe(true)

    m.watch('dev1', track('b'))
    expect(m.isSpeaking('dev1')).toBe(false)
    expect(fake.context.createAnalyser).toHaveBeenCalledTimes(2)
  })

  it('unwatch tears the nodes down and clears the tile', () => {
    const fake = fakeContext()
    const m = monitorWith(fake)
    m.watch('dev1', track())
    fake.setLevel(LOUD)
    m.poll(0)

    m.unwatch('dev1')
    expect(m.isSpeaking('dev1')).toBe(false)
    expect(fake.disconnected).toEqual(['source', 'analyser', 'gain'])
  })

  it('survives a disconnect that throws on an already-closed context', () => {
    const fake = fakeContext()
    const m = monitorWith(fake)
    m.watch('dev1', track())
    fake.analyser.disconnect.mockImplementation(() => {
      throw new Error('context closed')
    })
    expect(() => m.unwatch('dev1')).not.toThrow()
  })

  it('retain drops the devices that have left', () => {
    const fake = fakeContext()
    const m = monitorWith(fake)
    m.watch('dev1', track('a'))
    m.watch('dev2', track('b'))
    fake.setLevel(LOUD)
    m.poll(0)
    expect([...m.speaking()].sort()).toEqual(['dev1', 'dev2'])

    m.retain(['dev1'])
    expect([...m.speaking()]).toEqual(['dev1'])
    expect(m.isSpeaking('dev2')).toBe(false)
  })

  it('calls onChange when the set changes, and not when it does not', () => {
    // Twenty polls a second repainting every tile is how a speaking
    // indicator becomes the most expensive thing on the page.
    const fake = fakeContext()
    const onChange = vi.fn()
    const m = monitorWith(fake, onChange)
    m.watch('dev1', track())

    fake.setLevel(SILENT)
    m.poll(0)
    expect(onChange).not.toHaveBeenCalled()

    fake.setLevel(LOUD)
    m.poll(10)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect([...onChange.mock.calls[0]![0]]).toEqual(['dev1'])

    m.poll(20) // still speaking, nothing new to say
    m.poll(30)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('resumes a context that was created suspended', () => {
    // A context opened outside a user gesture starts suspended, and a
    // suspended analyser answers with silence for ever without erroring.
    const fake = fakeContext()
    fake.context.state = 'suspended'
    monitorWith(fake).watch('dev1', track())
    expect(fake.context.resume).toHaveBeenCalled()
  })

  it('opens exactly one context however many tracks it taps', () => {
    const fake = fakeContext()
    const m = monitorWith(fake)
    m.watch('dev1', track('a'))
    m.watch('dev2', track('b'))
    m.watch('dev3', track('c'))
    expect(fake.context.createMediaStreamSource).toHaveBeenCalledTimes(3)
    expect(fake.context.createAnalyser).toHaveBeenCalledTimes(3)
  })

  it('close stops everything and shuts the context', () => {
    const fake = fakeContext()
    const m = monitorWith(fake)
    m.watch('dev1', track())
    m.close()
    expect(m.isSpeaking('dev1')).toBe(false)
    expect(fake.context.close).toHaveBeenCalled()
  })
})
