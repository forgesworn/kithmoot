import type { ParticipantIdentity } from '../../src/identity.js'
import { BrowserLink, type LinkOwnership, type PairedBox } from './browser-link.js'
import { startBrowserLink } from './browser-link-runtime.js'
import { BrowserLinkRelay } from './browser-link-relay.js'
import type { LinkEngine, LinkListener, LinkRequest, LinkResponse, LinkSocket, StartLink } from './browser-link-types.js'
import { BrowserMlsGrantForeground, type MlsGrantForegroundScope } from './mls-grant-custody.js'
import { BrowserMlsGrantLinkVault, MLS_GRANT_LINK_OWNER } from './mls-grant-link-vault.js'
import { mlsGrantScope, type MlsGrantRecord } from './mls-grant-ledger.js'

const stale = () => new Error('The dedicated grant endpoint is unavailable in this foreground account.')
interface Binding { scope: MlsGrantForegroundScope; account: string; identity: ParticipantIdentity; closing: boolean; check(network?: boolean): void }

/** Dedicated development grant carrier, with distinct sealed seed/routes and
 * single-writer ownership. The actual application owner privately constructs
 * this concrete endpoint; StartLink is only a low-level native-browser test
 * seam. Ordinary account/persona endpoints are never accepted as substitutes.
 * Publication refusal/timeout does not imply withdrawal or remote no-live. */
export class BrowserMlsGrantEndpoint {
  readonly #link: BrowserLink
  #binding?: Binding
  #late = new Set<Promise<unknown>>()
  #carriers = new Set<BrowserLinkRelay>()
  #sockets = new Set<LinkSocket>()
  #stopping: Promise<void> = Promise.resolve()
  #shutdownFailed = false
  #owned = false
  #closing = false
  #retired = new WeakSet<MlsGrantForegroundScope>()
  constructor(private readonly foreground: BrowserMlsGrantForeground,
    private readonly identity: () => ParticipantIdentity | undefined, private readonly mayConnect: () => boolean,
    start: StartLink = startBrowserLink) {
    if (!(foreground instanceof BrowserMlsGrantForeground)) throw stale()
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
      const held = navigator.locks.request(MLS_GRANT_LINK_OWNER, { ifAvailable: true }, async lock => {
        try {
          this.#bound().check()
          if (!lock || signal.aborted) throw stale()
        } catch (error) { reject(error); return }
        this.#owned = true
        await new Promise<void>(unlock => {
          let released = false
          resolve(async () => {
            await this.#drainLate()
            // A failed engine stop retains native ownership until page exit.
            if (this.#shutdownFailed) throw new Error('Grant endpoint shutdown failed; close this page before reopening it.')
            if (!released) { released = true; this.#owned = false; unlock() }
            await held
          })
        })
      })
      void held.catch(reject)
    })
    this.#link = new BrowserLink(startOwned, new BrowserMlsGrantLinkVault(foreground, this), ownership)
  }
  ownsScope(scope: MlsGrantForegroundScope): boolean {
    if (!this.#owned || this.#closing || this.#shutdownFailed || this.#binding?.scope !== scope) return false
    try { this.#binding.check(); return true } catch { return false }
  }
  #bound(network = true): Binding {
    if (this.#shutdownFailed || this.#closing) throw stale()
    const scope = this.foreground.capture(), identity = this.identity(), account = identity?.pubkey
    if (!scope || !this.foreground.prepared(scope) || this.#retired.has(scope) || !account || !identity) throw stale()
    if (this.#binding && (this.#binding.scope !== scope || this.#binding.account !== account)) throw stale()
    if (!this.#binding) {
      const binding: Binding = { scope, account, identity, closing: false, check: (connect = true) => {
        if (this.#binding !== binding || binding.closing || this.#shutdownFailed || !this.foreground.prepared(scope) || this.identity() !== identity ||
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
    return this.#track(binding, () => this.#link.request(structuredClone(request)))
  }
  openSocket(url: string, route: string, listener: LinkListener): Promise<LinkSocket> {
    const binding = this.#bound()
    return this.#track(binding, async () => {
      let socket: LinkSocket | undefined, native: LinkSocket | undefined, closed = false
      const close = () => {
        if (closed) return
        closed = true
        if (socket) this.#sockets.delete(socket)
        try { native?.disconnect() } finally { listener.onClosed?.('Grant connection closed.') }
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
  carrier(record: MlsGrantRecord, identity: ParticipantIdentity): { publish: BrowserLinkRelay['publish']; close(): void } {
    const binding = this.#bound()
    if (identity !== binding.identity || record.issuer !== binding.account ||
        !this.#link.boxes().some(box => box.routeId === record.box.routeId && box.eventUrl === record.box.eventUrl)) throw stale()
    const signer: ParticipantIdentity = { pubkey: identity.pubkey, signEvent: template => this.#track(binding, () => identity.signEvent(template)) }
    const carrier = new BrowserLinkRelay(this, record.box, signer, { room: mlsGrantScope(record.device), kinds: [24242] })
    this.#carriers.add(carrier)
    return { publish: event => { binding.check(); return carrier.publish(event).then(() => binding.check()) },
      close: () => { carrier.close(); this.#carriers.delete(carrier) } }
  }
  /** Called externally by the private owner after synchronous foreground
   * invalidation, or in its workflow finally before releasing storage scope.
   * Never await foreground.invalidateAndWait from inside that scope callback. */
  stop(): Promise<void> {
    if (this.#closing || !this.#binding && !this.#owned) return this.#stopping
    const binding = this.#binding
    this.#closing = true
    if (binding) { binding.closing = true; this.#retired.add(binding.scope) }
    for (const carrier of this.#carriers) carrier.close()
    this.#carriers.clear()
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
