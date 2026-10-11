import type { ParticipantIdentity } from '../../src/identity.js'
import type { VmlsRevocationIdentity } from '../../src/vmls-revocation-request.js'
import { normaliseRelayConfig } from '../../src/relay-pool.js'
import type { MlsAccountContext } from './mls-persona-account.js'
import { BrowserMlsRoomForeground, type MlsRoomForegroundResult, type MlsRoomForegroundScope } from './mls-room-foreground.js'
import { BrowserMlsRoomEndpoint } from './mls-room-endpoint.js'
import { BrowserMlsPersonaStore } from './mls-persona-store.js'
import { BrowserPersonaLinks } from './mls-persona-link.js'
import { BrowserPersonaCoordinator } from './mls-persona-coordinator.js'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import { BrowserMlsRoomOperations } from './mls-room-operations.js'
import { mlsRoomIds, readMlsRoom } from './mls-room-store.js'

export interface MlsRoomDevelopmentContext extends MlsAccountContext {
  authority: {
    readonly owner: object; readonly signEvent: ParticipantIdentity['signEvent']
    readonly crypt?: { readonly owner: object; readonly encrypt: VmlsRevocationIdentity['encrypt']; readonly decrypt: VmlsRevocationIdentity['decrypt'] }
  }
}
interface Active { account: MlsRoomDevelopmentContext; identity: ParticipantIdentity; scope: MlsRoomForegroundScope; current(): boolean }
interface Services { links: BrowserPersonaLinks; coordinator: BrowserPersonaCoordinator; vault: CoordinatedMlsVault; rooms: BrowserMlsRoomOperations }
const stale = () => new Error('Reopen the development room workflow in the current foreground account.')
const hex = (value: string) => /^[0-9a-f]{64}(?![\s\S])/.test(value)
const matches = (next: MlsRoomDevelopmentContext['authority'] | undefined, before: MlsRoomDevelopmentContext['authority']) =>
  !!next && next.owner === before.owner && next.signEvent === before.signEvent &&
  next.crypt?.owner === before.crypt?.owner && next.crypt?.encrypt === before.crypt?.encrypt && next.crypt?.decrypt === before.crypt?.decrypt
async function join(work: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

/** Concrete room-only application composition. Construction performs no I/O.
 * It privately owns endpoint, persona and signer custody; callers cannot supply
 * service substitutes or a grant preparation/readiness mark. Creating, joining
 * and running a driver are separate ceremonies, still held in this slice. */
export class BrowserMlsRoomDevelopmentOwner {
  readonly #foreground = new BrowserMlsRoomForeground()
  readonly #endpoint = new BrowserMlsRoomEndpoint(this.#foreground,
    () => this.#active?.current() ? this.#active.identity : undefined,
    () => !!this.#active?.current() && this.#active.account.mode === 'normal')
  #active?: Active
  #services?: Services
  #epoch = 0
  #stopping: Promise<void> = Promise.resolve()
  constructor(private readonly context: () => MlsRoomDevelopmentContext | undefined) {}

  routes() { return this.#run(false, async (_services, active) => this.#endpoint.pairedBoxes(active.account.persona)) }
  pair(code: string, relays: readonly string[]) {
    if (typeof code !== 'string' || !code || code.length > 32_768) throw new Error('Enter a bounded room pairing code.')
    if (!Array.isArray(relays) || relays.length < 1 || relays.length > 6) throw new Error('Select one to six explicit Link relays.')
    const selected = normaliseRelayConfig([...relays]).map(relay => relay.url)
    return this.#run(true, async (_services, active) => {
      await this.#endpoint.resume(active.account.persona, selected)
      return this.#endpoint.pair(code)
    })
  }
  roomChoices() {
    return this.#run(true, (services, active) => this.#foreground.track(active.scope, () =>
      services.coordinator.transact(active.account.persona, async tx => {
        const result: { session: string; rendezvousKey: string; name: string; keeper?: string }[] = []
        for (const session of await mlsRoomIds(tx)) {
          const room = await readMlsRoom(tx, session)
          result.push({ session, rendezvousKey: room.binding.rendezvousKey, name: room.name, keeper: room.keeper })
        }
        return result
      }, active.current)))
  }
  /** External invalidation is synchronous. The returned promise joins all
   * actual endpoint, witness and foreground tails, even when another fails. */
  pause(): Promise<void> {
    this.#epoch++; this.#foreground.invalidate()
    this.#services?.vault.bump(); this.#services?.coordinator.invalidate()
    const previous = this.#stopping, endpoint = this.#endpoint.stop()
    const witnesses = this.#services?.links.pause() ?? Promise.resolve()
    this.#stopping = join([previous, endpoint, witnesses, this.#foreground.settled()])
    void this.#stopping.catch(() => {})
    return this.#stopping
  }
  async #run<T>(network: boolean, work: (services: Services, active: Active) => Promise<T>): Promise<MlsRoomForegroundResult<T>> {
    const account = this.context(), epoch = this.#epoch
    if (!account?.identity || account.identity.pubkey !== account.persona || !hex(account.persona) ||
        !account.authority?.owner || typeof account.authority.owner !== 'object' || typeof account.authority.signEvent !== 'function' ||
        account.authority.crypt && (!account.authority.crypt.owner || typeof account.authority.crypt.owner !== 'object' ||
          typeof account.authority.crypt.encrypt !== 'function' || typeof account.authority.crypt.decrypt !== 'function')) throw stale()
    const authority = Object.freeze({ ...account.authority,
      ...(account.authority.crypt ? { crypt: Object.freeze({ ...account.authority.crypt }) } : {}) })
    const captured = { ...account, authority }
    if (network && captured.mode !== 'normal') throw new Error('Room and witness connections are held in quiet and Tor-only modes.')
    const current = () => {
      const next = this.context()
      return epoch === this.#epoch && next?.persona === captured.persona && next.generation === captured.generation &&
        next.mode === captured.mode && next.identity?.pubkey === captured.persona && matches(next.authority, authority)
    }
    await this.#stopping
    if (!current()) return { state: 'interrupted' }
    return this.#foreground.run(captured.persona, current, async scope => {
      const check = () => { if (!scope.current()) throw stale() }
      const sign = authority.signEvent.bind(authority.owner)
      const identity: ParticipantIdentity = { pubkey: captured.persona,
        signEvent: template => this.#foreground.track(scope, () => sign(template)) }
      const active: Active = { account: captured, identity, scope, current: () => scope.current() }
      this.#active = active
      const services = this.#services ??= this.#create()
      try {
        check(); services.links.resume()
        const result = await work(services, active)
        check(); return result
      } finally {
        // Endpoint release drains nested work, never this outer callback.
        try { await join([this.#endpoint.stop(), services.links.pause()]) }
        catch (error) {
          this.#stopping = Promise.reject(error)
          void this.#stopping.catch(() => {})
          throw error
        }
        finally { if (this.#active === active) this.#active = undefined }
      }
    })
  }
  #create(): Services {
    const links = new BrowserPersonaLinks(() => !!this.#active?.current() && this.#active.account.mode === 'normal')
    const coordinator = new BrowserPersonaCoordinator(new BrowserMlsPersonaStore(), links.channels)
    const vault = new CoordinatedMlsVault(coordinator, { generation: () => this.#epoch })
    return { links, coordinator, vault, rooms: new BrowserMlsRoomOperations(coordinator, vault) }
  }
}
