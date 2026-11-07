// The worker half of the pumps, run against a stand-in worker scope: what is
// pinned is the tee (the volunteer still gets every frame), the swap, and
// key-frame bridging when no key frame comes by itself.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

interface Frame { data: ArrayBuffer; type?: 'key' | 'delta' }

const posted: unknown[] = []
const scope = new EventTarget() as EventTarget & { postMessage: (m: unknown) => void }
scope.postMessage = (m: unknown) => void posted.push(m)

function frame(byte: number, type?: 'key' | 'delta'): Frame {
  return { data: new Uint8Array([byte]).buffer, ...(type ? { type } : {}) }
}

/** A transformer whose readable a test feeds and whose writable it reads. */
function transformer(options: unknown, extra: Record<string, unknown> = {}) {
  let controller!: ReadableStreamDefaultController<Frame>
  const written: Frame[] = []
  const readable = new ReadableStream<Frame>({ start: (c) => void (controller = c) })
  const writable = new WritableStream<Frame>({ write: (f) => void written.push(f) })
  return { t: { readable, writable, options, ...extra }, push: (f: Frame) => controller.enqueue(f), written }
}

function attach(t: unknown, onEvent = true): void {
  const event = new Event('rtctransform')
  Object.assign(event, onEvent ? { transformer: t } : { transformer: { ...(t as object), options: undefined }, data: (t as { options: unknown }).options })
  scope.dispatchEvent(event)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeAll(async () => {
  vi.stubGlobal('self', scope)
  await import('./peer-relay-media.worker.js')
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('the pump worker', () => {
  it('says it is ready as soon as it loads', () => {
    expect(posted).toContainEqual({ op: 'ready' })
  })

  it('hands every tapped frame on to this device, and swaps them into the clock', async () => {
    const tap = transformer({ side: 'tap', tap: 1 }, { sendKeyFrameRequest: vi.fn(async () => {}) })
    const drive = transformer({ side: 'drive', drive: 2, tap: 1, video: true })
    attach(tap.t)
    attach(drive.t)
    tap.push(frame(9, 'key'))
    await tick()
    // The volunteer still sees the person it carries.
    expect(tap.written.map((f) => new Uint8Array(f.data)[0])).toEqual([9])

    drive.push(frame(1, 'delta'))
    await tick()
    expect(drive.written.map((f) => new Uint8Array(f.data)[0])).toEqual([9])
  })

  it('asks the source for a key frame when the far end cannot start, and when the far end asks', async () => {
    const ask = vi.fn(async () => {})
    const tap = transformer({ side: 'tap', tap: 3 }, { sendKeyFrameRequest: ask })
    const drive = transformer({ side: 'drive', drive: 4, tap: 3, video: true })
    attach(tap.t)
    attach(drive.t)
    // Only deltas from the source: the far end's decoder could not start on
    // any of them, and no key frame is coming by itself.
    tap.push(frame(1, 'delta'))
    tap.push(frame(2, 'delta'))
    await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(drive.written).toEqual([])

    // A second later the far end asks the clock for one; the source is asked.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 1_500)
    drive.push(frame(0, 'key'))
    await tick()
    expect(ask).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })

  it('reads its options from the event where an older engine put them', async () => {
    const tap = transformer({ side: 'tap', tap: 5 })
    attach(tap.t, false)
    tap.push(frame(7, 'key'))
    await tick()
    expect(tap.written).toHaveLength(1)
  })

  it('passes frames straight through when it cannot read its options, rather than stopping them', async () => {
    const odd = transformer({ side: 'sideways' })
    attach(odd.t)
    odd.push(frame(3))
    await tick()
    expect(odd.written).toHaveLength(1)
  })
})
