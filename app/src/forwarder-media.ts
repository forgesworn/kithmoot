import { deriveMediaKey } from '../../src/media-crypto.js'
import type { ForwarderMediaPipeline } from '../../src/mesh.js'

type Direction = 'encrypt' | 'decrypt'

interface TransformableEndpoint {
  transform?: unknown
}

interface ScriptTransformConstructor {
  new (worker: Worker, data?: unknown, transfer?: Transferable[]): unknown
}

interface ScriptTransformScope {
  RTCRtpScriptTransform?: ScriptTransformConstructor
  /** The worker, for a test to supply; a browser uses the bundled one. */
  createWorker?: () => Worker
}

/**
 * Browser-owned implementation of the library's forwarder-media seam.
 *
 * A library cannot make an `RTCRtpScriptTransform`: the worker URL belongs to
 * the application bundler. This class keeps that browser concern here while
 * keeping route selection in `Mesh`. `ready` is deliberately narrow: the
 * server-forwarder route remains unavailable unless a real worker and the
 * standard transform constructor were both created.
 */
export class BrowserForwarderMediaPipeline implements ForwarderMediaPipeline {
  readonly #worker?: Worker
  readonly #Transform?: ScriptTransformConstructor
  /** Each endpoint's control port, and the device its key is bound to. */
  readonly #controls = new Map<MessagePort, string>()
  #roomKey?: Uint8Array
  #closed = false

  constructor(scope: ScriptTransformScope = globalThis as unknown as ScriptTransformScope) {
    this.#Transform = scope.RTCRtpScriptTransform
    if (!this.#Transform) return
    try {
      this.#worker = scope.createWorker?.() ?? new Worker(new URL('./forwarder-media.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      // CSP, a browser implementation gap, or worker construction failure:
      // all mean this path is unavailable. Mesh stays direct/assist/TURN.
      this.#Transform = undefined
    }
  }

  get ready(): boolean {
    return !this.#closed && this.#worker !== undefined && this.#Transform !== undefined && this.#roomKey !== undefined
  }

  /** Whether this browser could install a transform once the session hands
   * over its current epoch key. Kept separate from `ready`, which becomes
   * true only after that key has been supplied. */
  get available(): boolean {
    return !this.#closed && this.#worker !== undefined && this.#Transform !== undefined
  }

  rekey(roomKey: Uint8Array): boolean {
    if (this.#closed || !this.#worker || !this.#Transform || roomKey.byteLength !== 32) return false
    this.#roomKey = roomKey.slice()
    // The same per-sender derivation an endpoint was installed with. Posting
    // the room key itself left an endpoint keyed before an epoch change and
    // one keyed after it on different keys for good: the sender's frames
    // dropped and the receiver's undecryptable.
    for (const [control, device] of this.#controls) control.postMessage({ key: deriveMediaKey(this.#roomKey, device) })
    return true
  }

  protectSender(sender: unknown, senderDevice: string, _track: MediaStreamTrack): boolean {
    return this.#install(sender, 'encrypt', senderDevice)
  }

  protectReceiver(receiver: unknown, expectedDevice: string, _track: MediaStreamTrack): boolean {
    return this.#install(receiver, 'decrypt', expectedDevice)
  }

  #install(candidate: unknown, direction: Direction, device: string): boolean {
    if (!this.ready || !candidate || typeof candidate !== 'object') return false
    const endpoint = candidate as TransformableEndpoint
    // An endpoint that does not expose the standard writable `transform`
    // slot is not safe to send through this route. Do not silently fall back
    // to ordinary DTLS-SRTP, which ends at the server forwarder.
    if (!('transform' in endpoint)) return false
    try {
      const control = new MessageChannel()
      const key = deriveMediaKey(this.#roomKey!, device)
      endpoint.transform = new this.#Transform!(this.#worker!, { direction, key, control: control.port2 }, [control.port2])
      this.#controls.set(control.port1, device)
      return true
    } catch {
      return false
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const control of this.#controls.keys()) control.close()
    this.#controls.clear()
    this.#worker?.terminate()
    this.#roomKey = undefined
  }
}
