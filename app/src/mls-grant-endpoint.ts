import type { Event } from 'nostr-tools/pure'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import type { VaultContext } from './mls-vault.js'
import { keeperInboxAuthRequest, keeperInboxDestination, keeperInboxPermissionCurrent, type KeeperInboxAuthPrompt, type KeeperInboxAuthRequest, type KeeperInboxAuthReply } from './mls-keeper-inbox-auth.js'
import { publishMlsKeeperInboxDeposit } from './mls-keeper-inbox-deposit-relay.js'
import type { ParticipantIdentity } from '../../src/identity.js'
import { BrowserLink, type LinkOwnership, type PairedBox } from './browser-link.js'
import { startBrowserLink } from './browser-link-runtime.js'
import { BrowserLinkRelay, linkWebSocket } from './browser-link-relay.js'
import type { LinkEngine, LinkListener, LinkRequest, LinkResponse, LinkSocket, StartLink } from './browser-link-types.js'
import { BrowserMlsGrantForeground, type MlsGrantForegroundScope } from './mls-grant-custody.js'
import { BrowserMlsGrantLinkVault, MLS_GRANT_LINK_OWNER } from './mls-grant-link-vault.js'
import { MLS_KEEPER_INBOX_BUDGETS, readMlsKeeperInboxPage, type MlsKeeperInboxPage } from './mls-keeper-inbox-relay.js'
import { mlsBoxNode, mlsGrantScope, type MlsGrantRecord } from './mls-grant-ledger.js'

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
  #inboxSerial = 0
  #privateResume?: { check(): Promise<void> }
  #retired = new WeakSet<MlsGrantForegroundScope>()
  constructor(private readonly foreground: BrowserMlsGrantForeground,
    private readonly identity: () => ParticipantIdentity | undefined, private readonly mayConnect: () => boolean,
    start: StartLink = startBrowserLink) {
    if (!(foreground instanceof BrowserMlsGrantForeground)) throw stale()
    const startOwned: StartLink = async config => {
      this.#bound().check()
      const operation = this.#privateResume
      if (operation) await operation.check()
      this.#bound().check()
      const engine = await start(config)
      try {
        this.#bound().check()
        if (operation) await operation.check()
      } catch (error) {
        try { await engine.stop() } catch { this.#shutdownFailed = true }
        throw error
      }
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
    if (this.#privateResume) throw stale()
    const binding = this.#bound()
    if (account !== binding.account) throw stale()
    // BrowserLink already waits for native start/pair settlement. Registering
    // resume in #late would deadlock its error path against ownership release.
    const result = await this.#link.resume(account, relays)
    binding.check(); return result
  }
  async #saved(binding: Binding, box: Readonly<PairedBox>, current: () => boolean): Promise<void> {
    const check = () => { if (current() !== true) throw stale(); binding.check() }
    check()
    const node = mlsBoxNode(box)
    if (box.eventUrl !== keeperInboxDestination(node)) throw stale()
    const saved = await this.#link.pairedBoxes(binding.account)
    check()
    if (!saved.some(item => item.routeId === box.routeId && item.eventUrl === box.eventUrl && mlsBoxNode(item) === node)) throw stale()
  }
  /** Pin the actual sealed saved route around native startup. Grant custody
   * additionally permits only append-only route writes under this endpoint's
   * exclusive Web Lock; an existing route cannot be replaced or removed. */
  async resumeKeeperInbox(account: string, box: Readonly<PairedBox>, operationCurrent: () => boolean): Promise<PairedBox> {
    const binding = this.#bound(), selected = Object.freeze({ routeId: box.routeId, eventUrl: box.eventUrl })
    if (account !== binding.account || this.#privateResume || typeof operationCurrent !== 'function') throw stale()
    const operation = { check: async () => {
      if (this.#privateResume !== operation) throw stale()
      await this.#saved(binding, selected, operationCurrent)
      if (this.#privateResume !== operation) throw stale()
    } }
    this.#privateResume = operation
    try {
      await operation.check()
      const boxes = await this.#link.resume(account)
      await operation.check()
      if (!boxes.some(item => item.routeId === selected.routeId && item.eventUrl === selected.eventUrl)) throw stale()
      return selected
    } finally { if (this.#privateResume === operation) this.#privateResume = undefined }
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
  openSocket(url: string, route: string, listener: LinkListener, operationCurrent?: () => boolean): Promise<LinkSocket> {
    const binding = this.#bound(), selected = { routeId: route, eventUrl: url }
    const check = () => { if (operationCurrent && operationCurrent() !== true) throw stale(); binding.check() }
    return this.#track(binding, async () => {
      check()
      let socket: LinkSocket | undefined, native: LinkSocket | undefined, closed = false
      const close = () => {
        if (closed) return
        closed = true
        if (socket) this.#sockets.delete(socket)
        try { native?.disconnect() } finally { listener.onClosed?.('Grant connection closed.') }
      }
      native = await this.#link.openSocket(url, route, {
        onText: text => { try { check(); if (!closed) listener.onText?.(text) } catch { close() } }, onClosed: close,
      })
      try {
        if (operationCurrent) await this.#saved(binding, selected, operationCurrent)
        check()
        if (closed) throw stale()
        socket = { sendText: text => { try { check(); if (closed) throw stale(); native!.sendText(text) } catch (error) { close(); throw error } },
          path: () => { try { check(); if (closed) throw stale(); return native!.path() } catch (error) { close(); throw error } }, disconnect: close }
        this.#sockets.add(socket); listener.onOpen?.(); return socket
      } catch (error) { native.disconnect(); close(); throw error }
    })
  }
  /** Read p-tag keeper wraps over this endpoint's saved private route only.
   * Pairing is not event authority: Bothy must accept keeper NIP-42 before REQ.
   * No ordinary room carrier, directory or native WebSocket is involved. */
  async keeperInboxPage(box: Readonly<PairedBox>, input: {
    keeper: string; since: number; until: number; authenticate: boolean; current(): boolean
  }): Promise<MlsKeeperInboxPage> {
    const binding = this.#bound(), selected = Object.freeze({ routeId: box.routeId, eventUrl: box.eventUrl })
    const permission = { ...input, current: input.current.bind(input) }
    const live = () => {
      try {
        binding.check()
        return permission.current() && this.#link.boxes().some(saved => saved.routeId === selected.routeId && saved.eventUrl === selected.eventUrl)
      } catch { return false }
    }
    if (permission.authenticate !== true || permission.keeper !== binding.account || !live()) throw stale()
    const Socket = linkWebSocket(this, selected)
    const identity: ParticipantIdentity = { pubkey: binding.account, signEvent: template => this.#track(binding, async () => {
      if (!live()) throw stale()
      const event = await binding.identity.signEvent(template)
      if (!live()) throw stale()
      return event
    }) }
    return readMlsKeeperInboxPage({ relay: { url: selected.eventUrl, read: true, write: false, circle: true },
      keeper: permission.keeper, since: permission.since, until: permission.until, current: live, authentication: identity },
      url => new Socket(url), MLS_KEEPER_INBOX_BUDGETS.pageMs, () => Math.floor(Date.now() / 1000), () => `vmls-private-keeper-${++this.#inboxSerial}`)
  }
  /** Deposit one keeper wrap over the exact saved route. Device AUTH is
   * available only through the typed vault, with fresh operation consent. */
  async depositKeeperInbox(box: Readonly<PairedBox>, input: {
    keeper: string; permission: Event; event: Event; vault: CoordinatedMlsVault; vaultContext: VaultContext
    consent: KeeperInboxAuthPrompt; current(): boolean
  }): Promise<void> {
    const binding = this.#bound(), selected = Object.freeze({ routeId: box.routeId, eventUrl: box.eventUrl })
    if (!(input.vault instanceof CoordinatedMlsVault) || typeof input.current !== 'function' || typeof input.consent !== 'function') throw stale()
    const vault = input.vault, context = Object.freeze({ ...input.vaultContext }), keeper = input.keeper
    const node = mlsBoxNode(selected)
    if (selected.eventUrl !== keeperInboxDestination(node) || context.persona !== binding.account) throw stale()
    const permit = keeperInboxAuthRequest({ v: 1, box: node, keeper, permission: input.permission, challenge: '00'.repeat(32), expires_at: Math.floor(Date.now() / 1000) + 120 })
    if (!permit) throw stale()
    const source = input.event
    if (!source || typeof source.content !== 'string' || source.content.length > 40_000 || !Array.isArray(source.tags) ||
        source.tags.length !== 1 || !Array.isArray(source.tags[0]) || source.tags[0].length !== 2 ||
        source.tags[0].some(part => typeof part !== 'string' || part.length > 128)) throw stale()
    const event: Event = { id: source.id, pubkey: source.pubkey, sig: source.sig, kind: source.kind,
      content: source.content, created_at: source.created_at, tags: [[...source.tags[0]]] }
    const operationCurrent = input.current.bind(input), consent = input.consent
    const live = () => {
      try {
        if (!operationCurrent()) return false
        binding.check()
        return vault.current(context) && keeperInboxPermissionCurrent(permit, Math.floor(Date.now() / 1000)) &&
          this.#link.boxes().some(saved => saved.routeId === selected.routeId && saved.eventUrl === selected.eventUrl)
      } catch { return false }
    }
    if (!live()) throw stale()
    const Socket = linkWebSocket({ openSocket: (url, route, listener) => this.openSocket(url, route, listener, live) }, selected)
    let authorization: { request: KeeperInboxAuthRequest; reply: KeeperInboxAuthReply } | undefined
    await this.#track(binding, () => publishMlsKeeperInboxDeposit({ box: node, keeper, permission: permit.permission,
      event, current: live, signal: binding.scope.signal,
      authenticate: request => this.#track(binding, async () => {
        if (!live() || request.box !== node || request.keeper !== keeper || request.permission.id !== permit.permission.id) throw stale()
        const signed = await vault.signKeeperInboxAuthV1(context, request, consent, live)
        if (!signed.ok || !live()) throw stale()
        const accepted = await vault.acceptKeeperInboxAuthReply(request, signed.value)
        if (!accepted.ok || !live()) throw stale()
        authorization = { request, reply: accepted.value }
        return accepted.value.event
      }),
      beforePublish: () => this.#track(binding, async () => {
        if (!live() || !authorization) throw stale()
        const checked = await vault.acceptKeeperInboxAuthReply(authorization.request, authorization.reply)
        if (!checked.ok || !live()) throw stale()
      }),
    }, url => new Socket(url)))
    if (!live()) throw stale()
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
