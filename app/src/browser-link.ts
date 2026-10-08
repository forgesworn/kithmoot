import { linkEventUrl, linkRelays, readLinkPairing } from './browser-link-pairing.js'
import { BrowserLinkVault, wipeLinkState, wipeRoute, type LinkState, type LinkVault } from './browser-link-vault.js'
import type { LinkEngine, LinkListener, LinkRequest, LinkResponse, LinkSocket, StartLink } from './browser-link-types.js'

type Release = () => void | Promise<void>
export type LinkOwnership = (signal: AbortSignal) => Promise<Release>
export interface PairedBox { routeId: string; eventUrl: string }

/** Own the seed for the engine's entire lifetime. Web Locks are required:
 * running two endpoints with the same seed races rendezvous registrations.
 * Busy tabs refuse promptly; cancellation never steals another tab's lock. */
export const browserLinkOwnership: LinkOwnership = signal => new Promise((resolve, reject) => {
  if (!navigator.locks) { reject(new Error('This browser needs Web Locks for Bothy connections.')); return }
  const held = navigator.locks.request('kithmoot-browser-link-v1', { ifAvailable: true }, async lock => {
    if (!lock || signal.aborted) { reject(new Error(signal.aborted ? 'Bothy connection cancelled.' : 'Bothy is open in another tab. Close that connection first.')); return }
    await new Promise<void>(release => {
      const done = () => { signal.removeEventListener('abort', done); release() }
      signal.addEventListener('abort', done, { once: true })
      resolve(async () => { done(); await held })
    })
  })
  void held.catch(reject)
})

/** An account-bound, single-owner browser carrier. No public relay fallback.
 * Stop invalidates synchronously; every async boundary checks the generation.
 * Starting twice shares the one engine rather than stopping a room's engine. */
export class BrowserLink {
  #generation = 0
  #abort = new AbortController()
  #opening?: Promise<PairedBox[]>
  #engine?: LinkEngine
  #state?: LinkState
  #account?: string
  #release?: Release
  #pending: Promise<unknown> = Promise.resolve()
  #sockets = new Set<LinkSocket>()
  #stopping: Promise<void> = Promise.resolve()
  constructor(private start: StartLink, private vault: LinkVault = new BrowserLinkVault(), private ownership: LinkOwnership = browserLinkOwnership) {}

  resume(account: string, relays?: string[]): Promise<PairedBox[]> {
    if (!/^[0-9a-f]{64}$/.test(account)) return Promise.reject(new Error('Choose a signing account first.'))
    if (this.#account && this.#account !== account) return Promise.reject(new Error('Close the Bothy connection before changing account.'))
    if (this.#opening) return this.#opening
    if (this.#engine) return Promise.resolve(this.boxes())
    this.#account = account
    const generation = this.#generation
    const signal = this.#abort.signal
    const opening = this.#open(account, relays, generation, signal)
    this.#opening = opening
    void opening.finally(() => { if (this.#opening === opening) this.#opening = undefined }).catch(() => {})
    return opening
  }
  async #open(account: string, relays: string[] | undefined, generation: number, signal: AbortSignal): Promise<PairedBox[]> {
    let state: LinkState | undefined, engine: LinkEngine | undefined, release: Release | undefined
    try {
      await this.#stopping; this.#current(generation)
      release = await this.ownership(signal); this.#current(generation)
      state = await this.vault.read(); this.#current(generation)
      if (state && state.account !== account) throw new Error('This browser’s Bothy connection belongs to another account.')
      if (!state) {
        if (!relays) throw new Error('Choose your Link relay before connecting Bothy.')
        state = { account, transportSeed: crypto.getRandomValues(new Uint8Array(32)), relayUrls: linkRelays(relays), routes: [] }
        await this.vault.write(state); this.#current(generation)
      } else if (relays && JSON.stringify(linkRelays(relays)) !== JSON.stringify(state.relayUrls)) throw new Error('Resume with the saved Link relays.')
      engine = await this.start(state); this.#current(generation)
      this.#engine = engine; this.#state = state; this.#release = release
      return this.boxes()
    } catch (error) {
      await engine?.stop().catch(() => {})
      if (state) wipeLinkState(state)
      await release?.()
      if (generation === this.#generation) this.#account = undefined
      throw error
    }
  }
  boxes(): PairedBox[] { return this.#state?.routes.map(r => ({ routeId: r.routeId, eventUrl: linkEventUrl(r.card) })) ?? [] }

  /** Explicit local forgetting, never a claim of server-side revocation. */
  async forget(): Promise<void> {
    await this.stop()
    const release = await this.ownership(this.#abort.signal)
    try { if (!this.vault.clear) throw new Error('Bothy storage cannot be cleared.'); await this.vault.clear() }
    finally { await release() }
  }

  pair(uri: string): Promise<PairedBox> {
    const bundle = readLinkPairing(uri)
    const generation = this.#generation
    const work = this.#pending.then(async () => {
      this.#current(generation)
      const engine = this.#requireEngine(), state = this.#state!
      if (state.routes.length >= 16) throw new Error('This browser already has sixteen Bothy routes.')
      const route = await engine.pairRoute(bundle)
      try {
        this.#current(generation)
        const updated = { ...state, routes: [...state.routes, route] }
        await this.vault.write(updated); this.#current(generation)
        this.#state = updated
        return { routeId: route.routeId, eventUrl: linkEventUrl(route.card) }
      } catch (error) {
        wipeRoute(route)
        await engine.removeRoute(route.routeId).catch(() => {})
        throw error
      }
    }).finally(() => bundle.pairingSecret.fill(0))
    this.#pending = work.catch(() => {})
    return work
  }
  async request(request: LinkRequest): Promise<LinkResponse> {
    const generation = this.#generation
    this.#route(request.routeId)
    const reply = await this.#requireEngine().request(request)
    this.#current(generation)
    return reply
  }
  async openSocket(url: string, routeId: string, listener: LinkListener): Promise<LinkSocket> {
    const generation = this.#generation
    if (this.#route(routeId).eventUrl !== url) throw new Error('This event address is not the paired Bothy.')
    const live = () => generation === this.#generation
    let closed = false, held: LinkSocket | undefined
    const ended = () => {
      if (closed) return
      closed = true
      if (held) this.#sockets.delete(held)
      listener.onClosed?.('Bothy connection closed.')
    }
    const socket = await this.#requireEngine().openSocket(url, routeId, {
      onText: text => { if (live() && !closed) listener.onText?.(text) },
      onClosed: ended,
    })
    if (!live() || closed) { socket.disconnect(); throw new Error('Bothy connection cancelled.') }
    held = {
      sendText: text => { this.#current(generation); if (closed) throw new Error('Bothy connection closed.'); socket.sendText(text) },
      path: () => { this.#current(generation); return socket.path() },
      disconnect: () => { ended(); socket.disconnect() },
    }
    this.#sockets.add(held)
    listener.onOpen?.()
    return held
  }
  stop(): Promise<void> {
    ++this.#generation
    // Do not release ownership until engine shutdown completes. Abort only
    // the opening wait here; an acquired lock is released by its owner below.
    const opening = this.#opening
    const engine = this.#engine, release = this.#release, state = this.#state
    this.#engine = undefined; this.#state = undefined; this.#release = undefined; this.#account = undefined; this.#opening = undefined
    for (const socket of this.#sockets) { try { socket.disconnect() } catch {} }
    this.#sockets.clear()
    this.#stopping = this.#stopping.then(async () => {
      await opening?.catch(() => {})
      try { await engine?.stop() }
      finally {
        await this.#pending.catch(() => {})
        if (state) wipeLinkState(state)
        await release?.()
      }
    })
    return this.#stopping
  }
  #requireEngine(): LinkEngine { if (!this.#engine) throw new Error('Connect Bothy first.'); return this.#engine }
  #route(routeId: string): PairedBox { const box = this.boxes().find(r => r.routeId === routeId); if (!box) throw new Error('Unknown Bothy route.'); return box }
  #current(generation: number): void { if (generation !== this.#generation) throw new Error('Bothy connection cancelled.') }
}
