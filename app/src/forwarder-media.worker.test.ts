// The forwarder's media worker against a stand-in worker scope. Pins where it
// reads its options: Chromium puts them on `transformer.options` and leaves
// the event's `data` undefined, and a worker that looked only at `data`
// dropped every frame on a forwarded endpoint.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decryptFrame, type EncodedFrameLike } from '../../src/media-crypto.js'

const scope = new EventTarget()
const KEY = new Uint8Array(32).fill(5)

function transformer(options: unknown) {
  let controller!: ReadableStreamDefaultController<EncodedFrameLike>
  const written: EncodedFrameLike[] = []
  const readable = new ReadableStream<EncodedFrameLike>({ start: (c) => void (controller = c) })
  const writable = new WritableStream<EncodedFrameLike>({ write: (f) => void written.push(f) })
  return { t: { readable, writable, options }, push: (f: EncodedFrameLike) => controller.enqueue(f), written }
}

function attach(fields: Record<string, unknown>): void {
  const event = new Event('rtctransform')
  Object.assign(event, fields)
  scope.dispatchEvent(event)
}

/** A VP8 frame as a browser hands one out, metadata and all. */
function vp8(bytes: number[], type: 'key' | 'delta'): EncodedFrameLike {
  return { data: new Uint8Array(bytes).buffer, type, getMetadata: () => ({ mimeType: 'video/VP8' }) } as EncodedFrameLike
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeAll(async () => {
  vi.stubGlobal('self', scope)
  await import('./forwarder-media.worker.js')
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('the forwarder media worker', () => {
  it('reads its options from the transformer, as Chromium delivers them, and encrypts', async () => {
    const control = new MessageChannel()
    const sender = transformer({ direction: 'encrypt', key: KEY, control: control.port2 })
    attach({ transformer: sender.t })
    const plain = new Uint8Array(Array.from({ length: 32 }, (_, i) => i))
    sender.push(vp8([...plain], 'key'))
    await tick()
    expect(sender.written).toHaveLength(1)
    const sealed = new Uint8Array(sender.written[0]!.data)
    expect(sealed).not.toEqual(plain)
    expect(decryptFrame(sealed, KEY)).not.toBeNull()
    control.port1.close()
  })

  it('still reads options from the event where an older engine put them', async () => {
    const control = new MessageChannel()
    const sender = transformer(undefined)
    attach({ transformer: sender.t, data: { direction: 'encrypt', key: KEY, control: control.port2 } })
    sender.push(vp8(Array.from({ length: 16 }, () => 9), 'delta'))
    await tick()
    expect(sender.written).toHaveLength(1)
    control.port1.close()
  })
})
