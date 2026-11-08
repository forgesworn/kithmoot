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
 * - **The same codec on both hops.** Only VP8 video and Opus audio are
 *   carried, because those are what has been measured: the drive keeps the
 *   clock's own frame metadata and swaps only the bytes, and for codecs whose
 *   packetiser reads that metadata (VP9 and AV1 descriptors, H.264 profiles)
 *   nobody has yet shown the far end decodes the result. The clock's
 *   transceiver is limited to the source's codec before the offer goes out,
 *   and checked again once media flows: a mismatch, or no codec going out at
 *   all, fails the leg, and the pair finds another route.
 * - **Key frames from the source.** A far end that needs one asks the clock;
 *   the worker turns that into a request to the source, where the browser
 *   allows it.
 * - **A transform claimed before it is needed.** Measured in Chromium 151: a
 *   receiver transform attached after media has started receives no frames,
 *   audio or video, even after a key-frame request. So every receiver of a
 *   device that could help is tapped as it arrives, through `prepare`,
 *   whether helping is on yet or not; until a leg uses it the tap passes
 *   every frame straight on. Only once the worker has said it is running,
 *   because a tap on a worker that never loaded would stop the device's own
 *   picture and sound, and the worker is started when the room is built so
 *   it is running before the first track arrives. If the worker fails, every
 *   transform is taken off again.
 *
 * What is not measured: the CPU cost of the pass-through taps on a device
 * that never helps, whether a receiver whose tap is taken off after a worker
 * failure goes back to its decoder, key-frame requests in browsers without
 * `sendKeyFrameRequest`, and audio and video drift when the source's frames
 * are replaced one for one.
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

export interface RelayMediaScope {
  RTCRtpScriptTransform?: ScriptTransformConstructor
  RTCRtpReceiver?: { getCapabilities?: (kind: string) => { codecs: CodecLike[] } | null }
  Worker?: unknown
  /** The worker, for a test to supply; a browser uses the bundled one. */
  createWorker?: () => Worker
  /**
   * Whether this device could ever help, asked before any worker starts or
   * receiver is tapped. Taps go on every receiver of such a device from the
   * moment it arrives, helping on or not, so this keeps them off a device
   * that never could: a phone on mobile data, a browser that cannot forward
   * frames, a device measured behind a NAT. Absent means yes.
   */
  eligible?: () => boolean
}

/** How long after a leg starts the codecs on its two hops are compared. */
const CODEC_CHECK_MS = 4_000

const NOT_MEDIA = /\/(rtx|red|ulpfec|flexfec)$/i

/** The only codecs carried until others have been measured end to end. */
const CARRIED = new Set(['video/vp8', 'audio/opus'])

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
  /** The worker has said it is running. Nothing is tapped before this. */
  #workerReady = false
  /** Each receiver's tap, so one source carried to two pairs is tapped once:
   *  a receiver has room for one transform. */
  readonly #taps = new Map<object, number>()
  /** Receivers offered by `prepare` before the worker was ready. */
  readonly #pending = new Set<object>()
  readonly #drives = new Map<number, { leg: RelayLeg; tap: number; stats?: RelayStats; check?: ReturnType<typeof setTimeout> }>()
  #seq = 0
  #closed = false
  #broken = false

  constructor(scope: RelayMediaScope = globalThis as unknown as RelayMediaScope) {
    this.#scope = scope
  }

  #eligible(): boolean {
    try {
      return this.#scope.eligible?.() ?? true
    } catch {
      return false
    }
  }

  /** Whether this browser has what the pumps need. Does not start the worker. */
  get available(): boolean {
    return !this.#closed && !this.#broken && this.#scope.RTCRtpScriptTransform !== undefined && (this.#scope.createWorker !== undefined || this.#scope.Worker !== undefined)
  }

  /** True once the worker is running and has said so. */
  get ready(): boolean {
    return this.available && this.#workerReady
  }

  /** Started when this device offers, so a call nobody is helping in costs
   *  no worker. */
  warm(): void {
    if (this.#eligible()) this.#ensureWorker()
  }

  #ensureWorker(): Worker | undefined {
    if (this.#worker || !this.available) return this.#worker
    try {
      const worker = this.#scope.createWorker?.() ?? new Worker(new URL('./peer-relay-media.worker.ts', import.meta.url), { type: 'module' })
      worker.addEventListener('message', (event: MessageEvent<unknown>) => this.#onMessage(event.data))
      // A chunk that will not load after a deploy, a script error, CSP.
      worker.addEventListener('error', () => this.#fail())
      worker.addEventListener('messageerror', () => this.#fail())
      this.#worker = worker
    } catch {
      // A browser that will not make a module worker: no pumps here.
      this.#broken = true
      this.#worker = undefined
    }
    return this.#worker
  }

  prepare(receiver: unknown): void {
    if (!receiver || typeof receiver !== 'object' || !this.available || !this.#eligible()) return
    if (!this.#workerReady) {
      this.#ensureWorker()
      this.#pending.add(receiver)
      return
    }
    this.#tap(receiver)
  }

  /**
   * The worker has gone. Every transform it owned is taken off, so this
   * device's own media flows as if it had never offered, and every leg is
   * failed, so the pairs are told and move on.
   */
  #fail(): void {
    if (this.#broken) return
    this.#broken = true
    this.#workerReady = false
    this.#pending.clear()
    for (const receiver of this.#taps.keys()) this.#untransform(receiver)
    this.#taps.clear()
    for (const [drive, entry] of [...this.#drives]) {
      if (entry.check !== undefined) clearTimeout(entry.check)
      this.#drives.delete(drive)
      this.#untransform(entry.leg.sink.sender)
      entry.leg.fail('the pump worker stopped')
    }
    this.#worker?.terminate()
    this.#worker = undefined
  }

  #untransform(endpoint: unknown): void {
    try {
      ;(endpoint as { transform?: unknown }).transform = null
    } catch {
      // A connection that has closed keeps what it had, and carries nothing.
    }
  }

  /** No longer offering: give back every tap no leg is using. */
  release(): void {
    this.#pending.clear()
    const inUse = new Set([...this.#drives.values()].map((entry) => entry.tap))
    for (const [receiver, tap] of [...this.#taps]) {
      if (inUse.has(tap)) continue
      this.#untransform(receiver)
      this.#taps.delete(receiver)
      this.#worker?.postMessage({ op: 'untap', tap })
    }
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
    const entry: { leg: RelayLeg; tap: number; stats?: RelayStats; check?: ReturnType<typeof setTimeout> } = { leg, tap }
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
    // Not known to be one of the measured codecs is not carried.
    if (!codec || !CARRIED.has(codec.mimeType.toLowerCase())) return false
    const transceiver = leg.sink.transceiver as { setCodecPreferences?: (codecs: CodecLike[]) => void } | undefined
    // Nothing to set; the post-start check still catches a mismatch.
    if (typeof transceiver?.setCodecPreferences !== 'function') return true
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
    if (!this.#drives.has(drive)) return
    // Nothing going out after this long is a leg the far end refused or never
    // negotiated: a dead picture that the sound beside it would make look
    // healthy. Failed, so the pair moves on.
    if (outbound === undefined) {
      entry.leg.fail('nothing went out on the carried m-line')
      return
    }
    if (inbound !== undefined && inbound !== outbound) entry.leg.fail(`codec ${inbound} in, ${outbound} out`)
  }

  #tap(receiver: unknown): number | undefined {
    if (!receiver || typeof receiver !== 'object' || !('transform' in receiver)) return undefined
    const known = this.#taps.get(receiver)
    if (known !== undefined) return known
    if (!this.#workerReady) return undefined
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
    if (message?.op === 'ready') {
      if (this.#broken || this.#closed) return
      this.#workerReady = true
      for (const receiver of this.#pending) this.#tap(receiver)
      this.#pending.clear()
      return
    }
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
    this.#taps.clear()
    this.#pending.clear()
    this.#worker?.terminate()
    this.#worker = undefined
  }
}
