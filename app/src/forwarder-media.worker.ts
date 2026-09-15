/**
 * The worker half of KithMoot's forwarder-media transform.
 *
 * `RTCRtpScriptTransform` runs this independently for each RTP endpoint.
 * The forwarding server never receives the epoch key: only this worker does,
 * via the browser's local transform API, and it sees encoded media only.
 */
import { createFrameDecryptor, createFrameEncryptor, type EncodedFrameLike, type FrameTransformer } from '../../src/media-crypto.js'

type Direction = 'encrypt' | 'decrypt'

interface TransformData {
  direction: Direction
  key: Uint8Array
  control: MessagePort
}

interface ScriptTransformer {
  readable: ReadableStream<EncodedFrameLike>
  writable: WritableStream<EncodedFrameLike>
}

interface TransformEvent extends Event {
  transformer: ScriptTransformer
  data: TransformData
}

function validKey(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === 32
}

self.addEventListener('rtctransform', (event: Event) => {
  const { transformer, data } = event as TransformEvent
  if (!data || !validKey(data.key) || (data.direction !== 'encrypt' && data.direction !== 'decrypt')) return

  let transform: FrameTransformer = data.direction === 'encrypt'
    ? createFrameEncryptor(data.key)
    : createFrameDecryptor(data.key)

  // The epoch can rotate while an RTP endpoint is alive. The next frame uses
  // a newly-created transformer, hence a fresh salt and counter for every
  // sender; frames caught exactly at the boundary are dropped if they do not
  // authenticate, never passed onwards in cleartext.
  data.control.onmessage = (message: MessageEvent<unknown>) => {
    const key = (message.data as { key?: unknown } | undefined)?.key
    if (!validKey(key)) return
    transform = data.direction === 'encrypt' ? createFrameEncryptor(key) : createFrameDecryptor(key)
  }
  data.control.start()

  void transformer.readable
    .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
      transform: (frame, controller) => transform(frame, controller),
    }))
    .pipeTo(transformer.writable)
    // Closing a peer closes the stream. It is not an application error.
    .catch(() => {})
})
