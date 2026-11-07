/**
 * Peer assist's frame pumps, in the browser: the app's half of
 * `RelayMediaPipeline`.
 *
 * `Mesh` decides what to carry and adds the clock senders; this attaches the
 * transforms that move the frames, in the worker beside it
 * (`peer-relay-media.worker.ts`). Four things have to hold for a carried
 * stream to decode at the far end, and this file owns all four:
 *
 * - **A clock on each leg.** `Mesh` sends a clone of the received track, so
 *   the encoder produces a frame for every frame the source sends; the drive
 *   transform swaps each one for the source's.
 * - **The same codec on both hops.** The clock's transceiver is limited to
 *   the codec the source's receiver negotiated before the offer goes out, and
 *   checked again once media flows. A mismatch fails the leg, and the pair
 *   finds another route.
 * - **Key frames from the source.** A far end that needs one asks the clock;
 *   the worker turns that into a request to the source, where the browser
 *   allows it.
 * - **A transform claimed before it is needed.** Receivers are tapped as they
 *   arrive while this device is offering, through `prepare`, so a pair that
 *   asks later finds the tap already there.
 *
 * What is not measured: whether every browser lets a receiver's transform be
 * attached after its media has started (only needed when `prepare` came too
 * late), key-frame requests in browsers without `sendKeyFrameRequest`, and
 * audio and video drift when the source's frames are replaced one for one.
 */
import type { RelayLeg, RelayLegHandle, RelayMediaPipeline, RelayStats } from '../../src/peer-relay.js'

interface ScriptTransformConstructor {
  new (worker: Worker, options?: unknown, transfer?: Transferable[]): unknown
}

interface CodecLike {
  mimeType: string
  clockRate: number
  channels?: number
  sdpFmtpLine?: string
}

interface RelayMediaScope {
  RTCRtpScriptTransform?: ScriptTransformConstructor
  RTCRtpReceiver?: { getCapabilities?: (kind: string) => { codecs: CodecLike[] } | null }
  Worker?: unknown
  /** The worker, for a test to supply; a browser uses the bundled one. */
  createWorker?: () => Worker
}

/** How long after a leg starts the codecs on its two hops are compared. */
const CODEC_CHECK_MS = 4_000

const NOT_MEDIA = /\/(rtx|red|ulpfec|flexfec)$/i

function fmtp(line: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of (line ?? '').split(';')) {
    const [key, value] = part.split('=')
    if (key) out.set(key.trim().toLowerCase(), (value ?? '').trim().toLowerCase())
  }
  return out
}

/**
 * Whether a frame encoded as `a` decodes as `b`.
 *
 * Name, clock rate and channels always. Of the format parameters, only those
 * that change the bitstream: H.264's profile (the first two bytes of
 * `profile-level-id`) and packetisation mode, VP9's and AV1's profile. Opus
 * parameters such as `useinbandfec` change nothing a decoder needs.
 */
export function sameCodec(a: CodecLike, b: CodecLike): boolean {
  if (a.mimeType.toLowerCase() !== b.mimeType.toLowerCase()) return false
  if (a.clockRate !== b.clockRate) return false
  if ((a.channels ?? 1) !== (b.channels ?? 1)) return false
  const name = a.mimeType.toLowerCase()
  const fa = fmtp(a.sdpFmtpLine)
  const fb = fmtp(b.sdpFmtpLine)
  if (name === 'video/h264') {
    return (fa.get('profile-level-id') ?? '').slice(0, 4) === (fb.get('profile-level-id') ?? '').slice(0, 4) &&
      (fa.get('packetization-mode') ?? '0') === (fb.get('packetization-mode') ?? '0')
  }
  if (name === 'video/vp9') return (fa.get('profile-id') ?? '0') === (fb.get('profile-id') ?? '0')
  if (name === 'video/av1') return (fa.get('profile') ?? '0') === (fb.get('profile') ?? '0')
  return true
}

/** The codec a receiver is decoding, as its negotiated parameters list it:
 *  the first media codec, which is what the far end sends unless told
 *  otherwise. */
function negotiatedCodec(receiver: unknown): CodecLike | undefined {
  try {
    const parameters = (receiver as { getParameters?: () => { codecs?: CodecLike[] } }).getParameters?.()
    return parameters?.codecs?.find((codec) => !NOT_MEDIA.test(codec.mimeType))
  } catch {
    return undefined
  }
}

/** The codec actually in use on one side, from its stats report. */
async function codecInUse(endpoint: unknown, type: 'inbound-rtp' | 'outbound-rtp'): Promise<string | undefined> {
  const getStats = (endpoint as { getStats?: () => Promise<RTCStatsReport> } | undefined)?.getStats
  if (typeof getStats !== 'function') return undefined
  try {
    const report = await getStats.call(endpoint)
    let codecId: string | undefined
    report.forEach((stat: { type?: string; codecId?: string }) => {
      if (stat.type === type && stat.codecId) codecId = stat.codecId
    })
    if (!codecId) return undefined
    return (report.get(codecId) as { mimeType?: string } | undefined)?.mimeType?.toLowerCase()
  } catch {
    return undefined
  }
}

function sum(stats: RelayStats[]): RelayStats {
  const total: RelayStats = { received: 0, forwarded: 0, dropped: 0, starved: 0, bytesIn: 0, bytesOut: 0 }
  for (const s of stats) {
    total.received += s.received
    total.forwarded += s.forwarded
    total.dropped += s.dropped
    total.starved += s.starved
    total.bytesIn += s.bytesIn
    total.bytesOut += s.bytesOut
  }
  return total
}

export class BrowserRelayMediaPipeline implements RelayMediaPipeline {
  readonly #scope: RelayMediaScope
  #worker?: Worker
  /** Each receiver's tap, so one source carried to two pairs is tapped once:
   *  a receiver has room for one transform. */
  readonly #taps = new WeakMap<object, number>()
  readonly #drives = new Map<number, { leg: RelayLeg; stats?: RelayStats; check?: ReturnType<typeof setTimeout> }>()
  #seq = 0
  #closed = false
  #broken = false

  constructor(scope: RelayMediaScope = globalThis as unknown as RelayMediaScope) {
    this.#scope = scope
  }

  /** Whether this browser has what the pumps need. Does not start the worker. */
  get available(): boolean {
    return !this.#closed && !this.#broken && this.#scope.RTCRtpScriptTransform !== undefined && (this.#scope.createWorker !== undefined || this.#scope.Worker !== undefined)
  }

  get ready(): boolean {
    return this.available
  }

  /** Started on first use, so a call nobody is helping in costs no worker. */
  #ensureWorker(): Worker | undefined {
    if (this.#worker || !this.available) return this.#worker
    try {
      this.#worker = this.#scope.createWorker?.() ?? new Worker(new URL('./peer-relay-media.worker.ts', import.meta.url), { type: 'module' })
      this.#worker.addEventListener('message', (event: MessageEvent<unknown>) => this.#onMessage(event.data))
    } catch {
      // CSP, or a browser that will not make a module worker: no pumps here.
      this.#broken = true
      this.#worker = undefined
    }
    return this.#worker
  }

  prepare(receiver: unknown): void {
    this.#tap(receiver)
  }

  carry(leg: RelayLeg): RelayLegHandle | null {
    if (!this.ready) return null
    const worker = this.#ensureWorker()
    const Transform = this.#scope.RTCRtpScriptTransform
    if (!worker || !Transform) return null
    const sender = leg.sink.sender as { transform?: unknown } | null
    if (!sender || typeof sender !== 'object' || !('transform' in sender)) return null
    if (!this.#preferSourceCodec(leg)) return null
    const tap = this.#tap(leg.source.receiver)
    if (tap === undefined) return null
    const drive = ++this.#seq
    try {
      sender.transform = new Transform(worker, { side: 'drive', drive, tap, video: leg.source.track.kind === 'video' })
    } catch {
      return null
    }
    const entry: { leg: RelayLeg; stats?: RelayStats; check?: ReturnType<typeof setTimeout> } = { leg }
    entry.check = setTimeout(() => void this.#checkCodec(drive), CODEC_CHECK_MS)
    this.#drives.set(drive, entry)
    return {
      close: () => {
        const held = this.#drives.get(drive)
        if (held?.check !== undefined) clearTimeout(held.check)
        this.#drives.delete(drive)
        this.#worker?.postMessage({ op: 'close', drive })
        try {
          sender.transform = null
        } catch {
          // A sender whose connection has closed keeps what it had.
        }
      },
    }
  }

  /**
   * Limit the clock's m-line to the codec the source is sending, before the
   * offer that adds it goes out. Without this the clock would negotiate the
   * far end's first preference, and frames encoded as one codec would be
   * packetised and decoded as another.
   */
  #preferSourceCodec(leg: RelayLeg): boolean {
    const codec = negotiatedCodec(leg.source.receiver)
    const transceiver = leg.sink.transceiver as { setCodecPreferences?: (codecs: CodecLike[]) => void } | undefined
    // Without either half there is nothing to set; the post-start check
    // still catches a mismatch.
    if (!codec || typeof transceiver?.setCodecPreferences !== 'function') return true
    const capabilities = this.#scope.RTCRtpReceiver?.getCapabilities?.(leg.source.track.kind)?.codecs ?? []
    const same = capabilities.filter((candidate) => sameCodec(candidate, codec))
    if (same.length === 0) return false
    const retransmission = leg.source.track.kind === 'video' ? capabilities.filter((candidate) => /\/rtx$/i.test(candidate.mimeType)) : []
    try {
      transceiver.setCodecPreferences([...same, ...retransmission])
      return true
    } catch {
      return false
    }
  }

  async #checkCodec(drive: number): Promise<void> {
    const entry = this.#drives.get(drive)
    if (!entry) return
    entry.check = undefined
    const [inbound, outbound] = await Promise.all([
      codecInUse(entry.leg.source.receiver, 'inbound-rtp'),
      codecInUse(entry.leg.sink.sender, 'outbound-rtp'),
    ])
    if (!this.#drives.has(drive) || inbound === undefined || outbound === undefined) return
    if (inbound !== outbound) entry.leg.fail(`codec ${inbound} in, ${outbound} out`)
  }

  #tap(receiver: unknown): number | undefined {
    if (!receiver || typeof receiver !== 'object' || !('transform' in receiver)) return undefined
    const known = this.#taps.get(receiver)
    if (known !== undefined) return known
    const worker = this.#ensureWorker()
    const Transform = this.#scope.RTCRtpScriptTransform
    if (!worker || !Transform) return undefined
    const tap = ++this.#seq
    try {
      ;(receiver as { transform?: unknown }).transform = new Transform(worker, { side: 'tap', tap })
    } catch {
      return undefined
    }
    this.#taps.set(receiver, tap)
    return tap
  }

  #onMessage(data: unknown): void {
    const message = data as { op?: unknown; drive?: unknown; stats?: RelayStats } | undefined
    if (message?.op !== 'stats' || typeof message.drive !== 'number' || !message.stats) return
    const entry = this.#drives.get(message.drive)
    if (!entry) return
    entry.stats = message.stats
    // One figure per leg of the pair, which is what the indicator reads.
    const { pair, from } = entry.leg
    const legs = [...this.#drives.values()].filter((other) => other.leg.pair === pair && other.leg.from === from && other.stats)
    pair.report(from, sum(legs.map((other) => other.stats!)))
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const entry of this.#drives.values()) if (entry.check !== undefined) clearTimeout(entry.check)
    this.#drives.clear()
    this.#worker?.terminate()
    this.#worker = undefined
  }
}
