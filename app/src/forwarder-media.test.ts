import { expect, it } from 'vitest'
import { deriveMediaKey } from '../../src/media-crypto.js'
import { BrowserForwarderMediaPipeline } from './forwarder-media.js'

/** Records what each endpoint was installed with and what it is sent later. */
function fakeScope() {
  const installed: { key: Uint8Array; control: MessagePort }[] = []
  class FakeTransform {
    constructor(_worker: Worker, data?: unknown) { installed.push(data as { key: Uint8Array; control: MessagePort }) }
  }
  return { installed, scope: { RTCRtpScriptTransform: FakeTransform, createWorker: () => ({ terminate() {} }) as unknown as Worker } }
}

it('keys every endpoint for its own sender, before an epoch change and after it', async () => {
  const { installed, scope } = fakeScope()
  const pipeline = new BrowserForwarderMediaPipeline(scope)
  const first = new Uint8Array(32).fill(1)
  const next = new Uint8Array(32).fill(2)
  expect(pipeline.rekey(first)).toBe(true)
  const track = {} as MediaStreamTrack
  expect(pipeline.protectSender({ transform: undefined }, 'aa'.repeat(32), track)).toBe(true)
  expect(installed[0]!.key).toEqual(deriveMediaKey(first, 'aa'.repeat(32)))

  const heard = new Promise<unknown>(resolve => { installed[0]!.control.onmessage = event => resolve(event.data) })
  pipeline.rekey(next)
  // An endpoint installed after the change, for the same sender...
  expect(pipeline.protectReceiver({ transform: undefined }, 'aa'.repeat(32), track)).toBe(true)
  // ...and the one from before it must now hold the same key.
  expect(installed[1]!.key).toEqual(deriveMediaKey(next, 'aa'.repeat(32)))
  expect(await heard).toEqual({ key: deriveMediaKey(next, 'aa'.repeat(32)) })
  pipeline.close()
})
