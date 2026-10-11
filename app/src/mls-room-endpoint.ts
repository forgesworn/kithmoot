import type { ParticipantIdentity } from '../../src/identity.js'
import { BrowserLink, type LinkOwnership, type PairedBox } from './browser-link.js'
import { startBrowserLink } from './browser-link-runtime.js'
import type { LinkEngine, LinkListener, LinkRequest, LinkResponse, LinkSocket, StartLink } from './browser-link-types.js'
import { BrowserMlsRoomForeground, type MlsRoomForegroundScope } from './mls-room-foreground.js'
import { BrowserMlsRoomLinkVault, MLS_ROOM_LINK_OWNER } from './mls-room-link-vault.js'

const stale = () => new Error('The dedicated room endpoint is unavailable in this foreground account.')
interface Binding { scope: MlsRoomForegroundScope; account: string; identity: ParticipantIdentity; signEvent: ParticipantIdentity['signEvent']; closing: boolean; check(network?: boolean): void }

/** Dedicated development room carrier, with distinct sealed seed/routes and
 * single-writer ownership. The actual application owner privately constructs
 * this concrete endpoint; StartLink is only a low-level native-browser test
 * seam. Ordinary account/persona endpoints are never accepted as substitutes.
 * Publication refusal/timeout does not imply withdrawal or remote no-live. */
export class BrowserMlsRoomEndpoint {
  readonly #link: BrowserLink
  #binding?: Binding
  #late = new Set<Promise<unknown>>()
  #sockets = new Set<LinkSocket>()
  #stopping: Promise<void> = Promise.resolve()
  #shutdownFailed = false
  #owned = false
  #closing = false
  #retired = new WeakSet<MlsRoomForegroundScope>()
  constructor(private readonly foreground: BrowserMlsRoomForeground,
    private readonly identity: () => ParticipantIdentity | undefined, private readonly mayConnect: () => boolean,
    start: StartLink = startBrowserLink) {
    if (!(foreground instanceof BrowserMlsRoomForeground)) throw stale()
    const startOwned: StartLink = async config => {
      this.#bound().check()
      const engine = await start(config)
      const owned: LinkEngine = {
        pairRoute: bundle => engine.pairRoute(bundle), request: request => engine.request(request),
        openSocket: (url, route, listener) => engine.openSocket(url, route, listener),
        removeRoute: route => engine.removeRoute(route), retireRoute: route => engine.retireRoute(route), finalizeRoute: route => engine.finalizeRoute(route),
        stop: async () => { try { await engine.stop() } catch (error) { this.#shutdownFailed = true; throw error } },
      }
      return owned
    }
    const ownership: LinkOwnership = signal => new Promise((resolve, reject) => {
      if (!navigator.locks || this.#shutdownFailed) { reject(stale()); return }
      const held = navigator.locks.request(MLS_ROOM_LINK_OWNER, { ifAvailable: true }, async lock => {
        const binding = this.#binding
        try {
          this.#bound().check()
          if (!binding || !lock || signal.aborted) throw stale()
        } catch (error) { reject(error); return }
        this.#owned = true
        await new Promise<void>(unlock => {
          let released = false
          resolve(async () => {
            await this.#drainLate()
            await this.foreground.drain(binding!.scope)
            // A failed engine stop retains native ownership until page exit.
            if (this.#shutdownFailed) throw new Error('Room endpoint shutdown failed; close this page before reopening it.')
            if (!released) { released = true; this.#owned = false; unlock() }
            await held
          })
        })
      })
      void held.catch(reject)
    })
    this.#link = new BrowserLink(startOwned, new BrowserMlsRoomLinkVault(foreground, this), ownership)
  }
  ownsScope(scope: MlsRoomForegroundScope): boolean {
    if (!this.#owned || this.#closing || this.#shutdownFailed || this.#binding?.scope !== scope) return false
    try { this.#binding.check(); return true } catch { return false }
  }
  #bound(network = true): Binding {
    if (this.#shutdownFailed || this.#closing) throw stale()
    const scope = this.foreground.capture(), identity = this.identity(), account = identity?.pubkey
    if (!scope || !this.foreground.active(scope) || this.#retired.has(scope) || account !== scope.account || !identity) throw stale()
    if (this.#binding && (this.#binding.scope !== scope || this.#binding.account !== account)) throw stale()
    if (!this.#binding) {
      const binding: Binding = { scope, account, identity, signEvent: identity.signEvent, closing: false, check: (connect = true) => {
        if (this.#binding !== binding || binding.closing || this.#shutdownFailed || !this.foreground.active(scope) || this.identity() !== identity || identity.signEvent !== binding.signEvent || identity.pubkey !== account ||
            connect && this.mayConnect() !== true) throw stale()
      } }
      this.#binding = binding
      scope.signal.addEventListener('abort', () => { void this.stop().catch(() => {}) }, { once: true })
    }
    this.#binding.check(network)
    return this.#binding
  }
  #track<T>(binding: Binding, work: () => Promise<T>, network = true): Promise<T> {
    const pending = Promise.resolve().then(async () => {
      binding.check(network)
      const result = await work()
      binding.check(network)
      return result
    }).finally(() => this.#late.delete(pending))
    this.#late.add(pending); void pending.catch(() => {})
    return pending
  }
  async #drainLate(): Promise<void> { while (this.#late.size) await Promise.allSettled([...this.#late]) }
  async resume(account: string, relays?: string[]): Promise<PairedBox[]> {
    const binding = this.#bound()
    if (account !== binding.account) throw stale()
    // BrowserLink already waits for native start/pair settlement. Registering
    // resume in #late would deadlock its error path against ownership release.
    const result = await this.#link.resume(account, relays)
    binding.check(); return result
  }
  async pair(uri: string): Promise<PairedBox> {
    const binding = this.#bound()
    const result = await this.#link.pair(uri)
    binding.check(); return result
  }
  boxes(): PairedBox[] { this.#bound().check(); return this.#link.boxes() }
  async pairedBoxes(account: string): Promise<PairedBox[]> {
    const binding = this.#bound(false)
    if (account !== binding.account) throw stale()
    const boxes = await this.#link.pairedBoxes(account)
    binding.check(false); return boxes
  }
  request(request: LinkRequest): Promise<LinkResponse> {
    const binding = this.#bound()
    const selected = structuredClone(request)
    return this.#track(binding, async () => {
      const response = await this.#link.request(selected)
      try { binding.check(); return response }
      catch (error) { response.body.fill(0); throw error }
    })
  }
  openSocket(url: string, route: string, listener: LinkListener): Promise<LinkSocket> {
    const binding = this.#bound()
    return this.#track(binding, async () => {
      let socket: LinkSocket | undefined, native: LinkSocket | undefined, closed = false
      const close = () => {
        if (closed) return
        closed = true
        if (socket) this.#sockets.delete(socket)
        try { native?.disconnect() } finally { listener.onClosed?.('Room connection closed.') }
      }
      native = await this.#link.openSocket(url, route, {
        onText: text => { try { binding.check(); if (!closed) listener.onText?.(text) } catch { close() } }, onClosed: close,
      })
      try {
        binding.check()
        if (closed) throw stale()
        socket = { sendText: text => { try { binding.check(); if (closed) throw stale(); native!.sendText(text) } catch (error) { close(); throw error } },
          path: () => { try { binding.check(); if (closed) throw stale(); return native!.path() } catch (error) { close(); throw error } }, disconnect: close }
        this.#sockets.add(socket); listener.onOpen?.(); return socket
      } catch (error) { native.disconnect(); close(); throw error }
    })
  }
  /** Called externally by the private owner after synchronous foreground
   * invalidation, or in its workflow finally before releasing storage scope.
   * Never await foreground.invalidateAndWait from inside that scope callback. */
  stop(): Promise<void> {
    if (this.#closing || !this.#binding && !this.#owned) return this.#stopping
    const binding = this.#binding
    this.#closing = true
    if (binding) { binding.closing = true; this.#retired.add(binding.scope) }
    for (const socket of this.#sockets) { try { socket.disconnect() } catch {} }
    this.#sockets.clear()
    const native = this.#link.stop()
    const stopping = Promise.all([this.#stopping, native]).then(async () => {
      await this.#drainLate()
      if (this.#owned || this.#shutdownFailed) throw stale()
      if (this.#binding === binding) this.#binding = undefined
      this.#closing = false
    })
    this.#stopping = stopping
    void stopping.catch(() => {})
    return stopping
  }
}
