/**
 * The worker half of peer assist's frame pumps.
 *
 * Two kinds of transform run here, both through `RTCRtpScriptTransform`:
 *
 * - a **tap** on a receiver this device already has, carrying one person's
 *   media to it on the call. Each frame is copied into every leg that carries
 *   that person onwards, and then handed on to this device's own decoder
 *   unchanged, because the volunteer is on the call and still sees and hears
 *   them.
 * - a **drive** on the clock sender added to the connection to the other end
 *   of a pair. The clock is a clone of the same received track, so its
 *   encoder ticks at the source's own rate; every frame it produces is
 *   replaced with the next one the tap queued, or dropped when there is none.
 *
 * Both run in this one worker so a frame passes from tap to drive without a
 * copy across threads. Nothing here reads a frame's contents: bytes are
 * copied and counted, and a video frame's `type` is read to know when a
 * decoder at the far end can start.
 */
import { FrameRelay } from '../../src/peer-relay.js'
import type { RelayStats } from '../../src/peer-relay.js'
import type { EncodedFrameLike } from '../../src/media-crypto.js'

interface ScriptTransformer {
  readable: ReadableStream<EncodedFrameLike>
  writable: WritableStream<EncodedFrameLike>
  /** The options given to `RTCRtpScriptTransform`, per the standard. */
  options?: unknown
  /** Receiver side: ask the sender for a key frame. Not in every browser. */
  sendKeyFrameRequest?: () => Promise<void>
}

type Options =
  | { side: 'tap'; tap: number }
  | { side: 'drive'; drive: number; tap: number; video: boolean }

interface Tap {
  transformer?: ScriptTransformer
  drives: Set<number>
  lastKeyRequest: number
}

/** The shortest gap between two key-frame requests to one source. A decoder
 *  that is waiting asks on every frame; the source should hear once. */
const KEY_REQUEST_GAP_MS = 1_000
const STATS_EVERY_MS = 2_000

const taps = new Map<number, Tap>()
const drives = new Map<number, { relay: FrameRelay; tap: number }>()

function tapFor(id: number): Tap {
  let tap = taps.get(id)
  if (!tap) {
    tap = { drives: new Set(), lastKeyRequest: 0 }
    taps.set(id, tap)
  }
  return tap
}

/**
 * Key-frame bridging. The far end's decoder asks the clock's encoder for a
 * key frame, because that is the sender it can see; the clock's key frame is
 * worthless to it, so the request is passed back to the source instead.
 */
function requestKeyFrame(id: number): void {
  const tap = taps.get(id)
  const ask = tap?.transformer?.sendKeyFrameRequest
  if (!tap || typeof ask !== 'function') return
  const now = Date.now()
  if (now - tap.lastKeyRequest < KEY_REQUEST_GAP_MS) return
  tap.lastKeyRequest = now
  void ask.call(tap.transformer).catch(() => {})
}

function validOptions(value: unknown): value is Options {
  const options = value as Partial<Options> | undefined
  if (!options || typeof options !== 'object') return false
  if (options.side === 'tap') return Number.isSafeInteger(options.tap)
  if (options.side === 'drive') {
    const drive = options as Partial<Extract<Options, { side: 'drive' }>>
    return Number.isSafeInteger(drive.drive) && Number.isSafeInteger(drive.tap) && typeof drive.video === 'boolean'
  }
  return false
}

self.addEventListener('rtctransform', (event: Event) => {
  const transformer = (event as Event & { transformer: ScriptTransformer }).transformer
  // `transformer.options` is the standard place; an older engine put them on
  // the event.
  const options = transformer.options ?? (event as Event & { data?: unknown }).data
  if (!validOptions(options)) {
    // Never leave a stream unconsumed: that would stop this device's own
    // media on the endpoint, which is worse than not carrying anybody.
    void transformer.readable.pipeTo(transformer.writable).catch(() => {})
    return
  }

  if (options.side === 'tap') {
    const tap = tapFor(options.tap)
    tap.transformer = transformer
    void transformer.readable
      .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
        transform: (frame, controller) => {
          for (const id of tap.drives) drives.get(id)?.relay.accept(frame)
          controller.enqueue(frame)
        },
      }))
      .pipeTo(transformer.writable)
      .catch(() => {})
    return
  }

  const tapId = options.tap
  const relay = new FrameRelay({ keyFrames: options.video, onKeyFrameNeeded: () => requestKeyFrame(tapId) })
  drives.set(options.drive, { relay, tap: tapId })
  tapFor(tapId).drives.add(options.drive)
  void transformer.readable
    .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
      transform: (frame, controller) => {
        if (options.video && frame.type === 'key') requestKeyFrame(tapId)
        if (relay.fill(frame)) controller.enqueue(frame)
      },
    }))
    .pipeTo(transformer.writable)
    .catch(() => {})
})

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data as { op?: unknown; drive?: unknown } | undefined
  if (message?.op !== 'close' || typeof message.drive !== 'number') return
  const drive = drives.get(message.drive)
  if (!drive) return
  drive.relay.close()
  drives.delete(message.drive)
  taps.get(drive.tap)?.drives.delete(message.drive)
})

setInterval(() => {
  for (const [drive, { relay }] of drives) {
    const stats: RelayStats = { ...relay.stats }
    self.postMessage({ op: 'stats', drive, stats })
  }
}, STATS_EVERY_MS)
