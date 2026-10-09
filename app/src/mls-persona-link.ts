import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { startBrowserLink } from './browser-link-runtime.js'
import { linkRelays, readLinkPairing } from './browser-link-pairing.js'
import type { LinkConfig, LinkEngine, LinkRoute, StartLink } from './browser-link-types.js'
import type { PersonaWitnessChannels } from './mls-persona-coordinator.js'
import type { PersonaWitnessRoute } from './mls-persona-store.js'
import { MlsWitnessLink } from './mls-witness-link.js'

/** Dedicated persona endpoints. Call pair/channels only under that persona's
 * Web Lock and close the returned channel before unlocking. No idle endpoint
 * survives the operation, so another tab may safely acquire the same writer.
 * The app must pause on account/mode changes; mayConnect excludes quiet and
 * Tor-only modes. This class never borrows the ordinary account Link engine. */
export class BrowserPersonaLinks {
  #paused = false
  #generation = 0
  #leases = new Set<Lease>()
  constructor(private readonly mayConnect: () => boolean, private readonly start: StartLink = startBrowserLink) {}

  readonly channels: PersonaWitnessChannels = async (_persona, seed, route, current) => {
    if (!route || !this.#allowed(current)) return null
    const restored: LinkRoute = { routeId: route.routeId, card: hexToBytes(route.card), pairedRouteSecret: hexToBytes(route.pairedRouteSecret),
      cardSerial: BigInt(route.cardSerial), cardVerifiedAt: BigInt(route.cardVerifiedAt) }
    const lease = await this.#open(seed, route.relayUrls, [restored], current)
    if (!lease) return null
    const carrier = new MlsWitnessLink({ request: async request => {
      if (!lease.active()) throw new Error('Persona connection is unavailable.')
      const reply = await (await lease.engine).request(request)
      if (!lease.active()) throw new Error('Persona connection is unavailable.')
      return reply
    } }, route.routeId)
    return { read: request => carrier.read(request), advance: request => carrier.advance(request), close: () => lease.close() }
  }

  /** The keeper supplies a code from `bothyd witness pair`. The server's
   * secret slot controls witness-only authority; the URI does not prove it. */
  async pair(seed: Uint8Array, uri: string, relays: readonly string[], current: () => boolean): Promise<PersonaWitnessRoute | null> {
    if (!this.#allowed(current)) return null
    const relayUrls = linkRelays(relays)
    const pairing = readLinkPairing(uri)
    const generation = this.#generation
    let lease: Lease | null = null, route: LinkRoute | undefined, saved: PersonaWitnessRoute | null = null
    try {
      lease = await this.#open(seed, relayUrls, [], current)
      if (!lease) return null
      route = await (await lease.engine).pairRoute(pairing)
      if (!lease.active()) return null
      saved = { routeId: route.routeId, card: bytesToHex(route.card), pairedRouteSecret: bytesToHex(route.pairedRouteSecret),
        cardSerial: String(route.cardSerial), cardVerifiedAt: String(route.cardVerifiedAt), relayUrls }
    } finally { pairing.pairingSecret.fill(0); route?.pairedRouteSecret.fill(0); await lease?.close() }
    return generation === this.#generation && this.#allowed(current) ? saved : null
  }

  async pause(): Promise<void> {
    this.#paused = true; this.#generation++
    // Includes starts which have not returned a handle yet. Never abandon a
    // late endpoint merely because the UI stopped waiting for the operation.
    const results = await Promise.allSettled([...this.#leases].map(lease => lease.close()))
    const failed = results.find(r => r.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  resume(): void {
    if (this.#leases.size) throw new Error('Persona connections are still stopping.')
    this.#paused = false
  }
  #allowed(current: () => boolean): boolean { return !this.#paused && this.mayConnect() && current() }
  async #open(seed: Uint8Array, relays: readonly string[], routes: LinkRoute[], current: () => boolean): Promise<Lease | null> {
    let lease: Lease | undefined
    try {
      if (!this.#allowed(current)) return null
      if (seed.length !== 32) throw new Error('Invalid persona writer.')
      const generation = this.#generation
      const relayUrls = linkRelays(relays)
      const config: LinkConfig = { transportSeed: seed.slice(), relayUrls, routes }
      lease = new Lease(this.start, config, () => generation === this.#generation && this.#allowed(current), () => this.#leases.delete(lease!))
      this.#leases.add(lease)
      await lease.engine
      if (!lease.active()) { await lease.close(); return null }
      return lease
    } catch (error) { await lease?.close(); throw error }
    finally { for (const route of routes) route.pairedRouteSecret.fill(0) }
  }
}

class Lease {
  readonly engine: Promise<LinkEngine>
  #closed = false
  #stopping: Promise<void> | undefined
  constructor(start: StartLink, config: LinkConfig, private readonly current: () => boolean, private readonly stopped: () => void) {
    this.engine = Promise.resolve().then(() => {
      if (!this.active()) throw new Error('Persona connection is unavailable.')
      return start(config)
    }).finally(() => config.transportSeed.fill(0))
  }
  active(): boolean { return !this.#closed && this.current() }
  close(): Promise<void> {
    this.#closed = true
    return this.#stopping ??= (async () => {
      let engine: LinkEngine
      try { engine = await this.engine } catch { this.stopped(); return }
      await engine.stop()
      this.stopped()
    })()
  }
}
