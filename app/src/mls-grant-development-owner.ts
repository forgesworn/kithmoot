import type { Event } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import type { VmlsRevocationIdentity } from '../../src/vmls-revocation-request.js'
import { normaliseRelayConfig } from '../../src/relay-pool.js'
import type { MlsAccountContext } from './mls-persona-account.js'
import { BrowserMlsGrantForeground, type BrowserMlsGrantCustody, type MlsGrantForegroundResult } from './mls-grant-custody.js'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'
import { BrowserMlsGrantLedger, mlsBoxNode } from './mls-grant-ledger.js'
import { BrowserMlsPersonaStore } from './mls-persona-store.js'
import { BrowserPersonaLinks } from './mls-persona-link.js'
import { BrowserPersonaCoordinator } from './mls-persona-coordinator.js'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import { BrowserMlsRoomOperations, type MlsRoomContext } from './mls-room-operations.js'
import { BrowserMlsKeeperAdmission } from './mls-keeper-admission.js'
import { BrowserMlsRevocationInbox, type MlsRevocationInboxContext } from './mls-revocation-inbox.js'
import { BrowserMlsKeeperDecisions, type MlsKeeperDecisionPlan } from './mls-keeper-decisions.js'
import { BrowserMlsKeeperRequestController } from './mls-keeper-request-controller.js'
import { BrowserMlsMembershipController, type MlsRemovalPlan } from './mls-membership-controller.js'
import { BrowserMlsKeeperInboxFetch, type MlsKeeperInboxReadPermission } from './mls-keeper-inbox-fetch.js'
import { NostrMlsKeeperInboxTransport } from './mls-keeper-inbox-relay.js'
import { NostrVmlsRevocationTransport } from './mls-revocation-relay.js'
import { mlsRoomIds, readMlsRoom } from './mls-room-store.js'

export interface MlsDevelopmentRoom { session: string; rendezvousKey: string }
export interface MlsGrantDevelopmentContext extends MlsAccountContext {
  /** Stable references from the actual account session, before binding a
   * fresh UI wrapper. Same-pubkey signer replacement retires old workflows. */
  authority: {
    readonly owner: object; readonly signEvent: ParticipantIdentity['signEvent']
    readonly crypt?: { readonly owner: object; readonly encrypt: VmlsRevocationIdentity['encrypt']; readonly decrypt: VmlsRevocationIdentity['decrypt'] }
  }
}
interface Active {
  account: MlsGrantDevelopmentContext; identity: ParticipantIdentity; revocation?: VmlsRevocationIdentity
  inbox: MlsRevocationInboxContext; room?: MlsRoomContext; selected?: MlsDevelopmentRoom
  current(): boolean
}
interface Services {
  links: BrowserPersonaLinks; coordinator: BrowserPersonaCoordinator; vault: CoordinatedMlsVault
  rooms: BrowserMlsRoomOperations; ledger: BrowserMlsGrantLedger; inbox: BrowserMlsRevocationInbox
  decisions: BrowserMlsKeeperDecisions; keeper: BrowserMlsKeeperRequestController; member: BrowserMlsMembershipController
}
const held = (): MlsGrantForegroundResult<never> => ({ state: 'interrupted' })
const stale = () => new Error('Reopen the development grant workflow in the current foreground account.')
const hex = (value: string) => /^[0-9a-f]{64}(?![\s\S])/.test(value)
const snapshot = <T>(value: T, maximum = 256 * 1024): T => {
  const copy = structuredClone(value)
  const encoded = JSON.stringify(copy)
  if (!encoded || encoded.length > maximum) throw new Error('The development workflow input is too large or invalid.')
  return copy
}
const relaySnapshot = (relays: readonly string[]) => {
  if (!Array.isArray(relays) || relays.length < 1 || relays.length > 6) throw new Error('Select one to six explicit relays.')
  return normaliseRelayConfig([...relays]).map(relay => relay.url)
}
const authorityMatches = (next: MlsGrantDevelopmentContext['authority'] | undefined, before: MlsGrantDevelopmentContext['authority']) =>
  !!next && next.owner === before.owner && next.signEvent === before.signEvent &&
  next.crypt?.owner === before.crypt?.owner && next.crypt?.encrypt === before.crypt?.encrypt && next.crypt?.decrypt === before.crypt?.decrypt

/** Private concrete development composition. It accepts account context only:
 * no Store, structural Link, custody, ready mark, signer or service overrides.
 * Named grant workflows prepare once before constructing/entering any nested
 * persona, device, room, signer or network component. Generic room creation is
 * deliberately owned elsewhere. The development panel exposes these named
 * workflows; genuine room/driver acceptance remains required for closure. */
export class BrowserMlsGrantDevelopmentOwner {
  readonly #foreground = new BrowserMlsGrantForeground()
  readonly #endpoint = new BrowserMlsGrantEndpoint(this.#foreground, () => this.#active?.current() ? this.#active.identity : undefined,
    () => !!this.#active?.current() && this.#active.account.mode === 'normal')
  #services?: Services
  #active?: Active
  #epoch = 0
  #controller?: AbortController
  #lastContext?: { persona: string; generation: string; mode: MlsAccountContext['mode']; authority: MlsGrantDevelopmentContext['authority'] }
  #stopping: Promise<void> = Promise.resolve()
  #sockets = new Map<WebSocket, Promise<void>>()
  constructor(private readonly context: () => MlsGrantDevelopmentContext | undefined) {}

  records() { return this.#run(false, services => services.ledger.records()) }
  roomChoices() {
    return this.#run(true, (services, active) => services.coordinator.transact(active.account.persona, async tx => {
      const choices: (MlsDevelopmentRoom & { name: string; keeper?: string })[] = []
      for (const session of await mlsRoomIds(tx)) {
        const room = await readMlsRoom(tx, session)
        choices.push({ session, rendezvousKey: room.binding.rendezvousKey, name: room.name, keeper: room.keeper })
      }
      return choices
    }, active.current))
  }
  routes() { return this.#run(false, async (_services, active) => this.#endpoint.pairedBoxes(active.account.persona)) }
  pair(code: string, relays: readonly string[]) {
    if (typeof code !== 'string' || !code || code.length > 32_768) throw new Error('Enter a bounded pairing code.')
    const selectedRelays = relaySnapshot(relays)
    return this.#run(true, async (_services, active) => {
      await this.#endpoint.resume(active.account.persona, selectedRelays)
      return this.#endpoint.pair(code)
    })
  }
  /** Caller selects a verified saved MLS leaf, never supplies its device,
   * persona, room name or arbitrary signed grant as installation authority. */
  install(room: MlsDevelopmentRoom, leaf: string, routeId: string) {
    return this.#run(true, async (services, active) => {
      const boxes = await this.#endpoint.pairedBoxes(active.account.persona), box = boxes.find(item => item.routeId === routeId)
      if (!box || !hex(leaf) || !active.room || !active.selected) throw stale()
      const authority = await services.rooms.roomRevocationAuthority(active.room, active.selected.session)
      const members = await services.rooms.members(active.room, active.selected.session)
      if (!active.current() || authority.state !== 'active' || authority.value.keeper !== active.account.persona || members.state !== 'active') throw stale()
      const member = members.value.find(item => item.leafId === leaf)
      if (!member || member.pending || member.homeBox !== mlsBoxNode(box)) throw new Error('Select a current verified member on this exact paired Bothy.')
      return services.ledger.installVerified(box, member.identity, member.device, { session: active.selected.session, leaf: member.leafId,
        name: authority.value.name, rendezvousKey: active.selected.rendezvousKey, homeBox: member.homeBox })
    }, room)
  }
  memberView(room: MlsDevelopmentRoom) { return this.#run(true, services => services.member.view(), room) }
  memberPlan(room: MlsDevelopmentRoom, kind: 'device' | 'person', target: string, compromised: boolean) {
    return this.#run(true, services => services.member.plan(kind, target, compromised), room)
  }
  memberBegin(room: MlsDevelopmentRoom, plan: MlsRemovalPlan) {
    const selected = snapshot(plan)
    if (!selected || !hex(selected.operation) || !['device', 'person'].includes(selected.kind) || !hex(selected.target) ||
        typeof selected.compromised !== 'boolean' || !selected.room || !Array.isArray(selected.members) || !Array.isArray(selected.grants)) throw new Error('Review a complete removal plan first.')
    return this.#run(true, services => services.member.begin(selected), room)
  }
  memberAdvance(room: MlsDevelopmentRoom, operation: string) { return this.#run(true, services => services.member.advance(operation), room) }
  keeperView() { return this.#run(true, services => services.inbox.view()) }
  keeperApprovals() { return this.#run(true, services => services.decisions.approvals(true)) }
  keeperReceive(wrappers: readonly Event[]) {
    const selected = snapshot(wrappers, 3 * 1024 * 1024)
    if (!Array.isArray(selected) || selected.length > 64 || selected.some(event => !event || !hex(event.id) || !hex(event.pubkey) ||
        !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.kind !== 1059 || !Array.isArray(event.tags) || typeof event.content !== 'string' || typeof event.sig !== 'string')) throw new Error('Select bounded keeper gift wraps.')
    return this.#run(true, (services, active) => {
      if (!active.revocation) throw new Error('This account cannot decrypt keeper requests.')
      return services.inbox.receive(selected, active.revocation)
    })
  }
  keeperCheck(discoveryRelays: readonly string[], permissions: readonly MlsKeeperInboxReadPermission[] = []) {
    const selectedRelays = relaySnapshot(discoveryRelays)
    if (!Array.isArray(permissions) || permissions.length > 6) throw new Error('Invalid keeper inbox read permissions.')
    const selectedPermissions = permissions.map(permission => {
      if (!permission || typeof permission.authenticate !== 'boolean' || typeof permission.current !== 'function') throw new Error('Invalid keeper inbox read permissions.')
      const relay = normaliseRelayConfig([snapshot(permission.relay)])[0]!
      // Only the predicate remains live; destinations and AUTH consent are
      // the click-time values, even while native preparation is blocked.
      return { relay, authenticate: permission.authenticate, current: permission.current.bind(permission) }
    })
    if (new Set(selectedPermissions.map(permission => permission.relay.url)).size !== selectedPermissions.length) throw new Error('Duplicate keeper inbox read permission.')
    return this.#run(true, (services, active) => {
      if (!active.revocation) throw new Error('This account cannot decrypt keeper requests.')
      const directory = new NostrVmlsRevocationTransport(selectedRelays, { socket: url => this.#socket(url) })
      const page = new NostrMlsKeeperInboxTransport(url => this.#socket(url))
      const fetch = new BrowserMlsKeeperInboxFetch(services.coordinator, services.inbox,
        { directory: keeper => directory.directory(keeper), page: query => page.page(query) }, () => this.#active?.inbox)
      return fetch.check(active.revocation, selectedPermissions)
    })
  }
  keeperReview(operation: string) { return this.#run(true, services => services.decisions.plan(operation)) }
  keeperDecide(plan: MlsKeeperDecisionPlan, approve: boolean) {
    if (typeof approve !== 'boolean') throw new Error('Select an explicit keeper decision.')
    const selected = this.#decisionSnapshot(plan)
    return this.#run(true, services => services.decisions.decide(selected, approve))
  }
  keeperApprove(plan: MlsKeeperDecisionPlan) {
    const selected = this.#decisionSnapshot(plan)
    return this.#run(true, services => services.keeper.approve(selected))
  }
  keeperAdvance(operation: string) { return this.#run(true, services => services.keeper.advance(operation)) }
  keeperComplete(operation: string) { return this.#run(true, services => services.decisions.complete(operation)) }
  #decisionSnapshot(plan: MlsKeeperDecisionPlan): MlsKeeperDecisionPlan {
    const selected = snapshot(plan)
    if (!selected || !selected.binding || !selected.prompt || !hex(selected.prompt.operation) || typeof selected.conflict !== 'boolean' ||
        !Array.isArray(selected.grants) || !Array.isArray(selected.rooms)) throw new Error('Review a complete keeper decision first.')
    return selected
  }

  /** External shutdown only. Invalidate storage synchronously before any
   * coordinator/room/endpoint shutdown; wait for every actual native tail. */
  pause(): Promise<void> {
    this.#epoch++; this.#controller?.abort(); this.#foreground.invalidate()
    this.#services?.rooms.invalidate(); this.#services?.vault.bump(); this.#services?.coordinator.invalidate()
    const endpoint = this.#endpoint.stop(), witnesses = this.#services?.links.pause()
    const sockets = this.#closeSockets()
    this.#stopping = Promise.all([this.#stopping, endpoint, witnesses, sockets, this.#foreground.settled()]).then(() => undefined)
    void this.#stopping.catch(() => {})
    return this.#stopping
  }
  async #run<T>(network: boolean, work: (services: Services, active: Active) => Promise<T>, room?: MlsDevelopmentRoom): Promise<MlsGrantForegroundResult<T>> {
    const account = this.context(), previous = this.#lastContext
    if (previous && (!account || account.persona !== previous.persona || account.generation !== previous.generation || account.mode !== previous.mode ||
        !authorityMatches(account.authority, previous.authority))) void this.pause().catch(() => {})
    if (!account?.identity || account.identity.pubkey !== account.persona || !hex(account.persona) ||
        !account.authority || typeof account.authority.owner !== 'object' || !account.authority.owner || typeof account.authority.signEvent !== 'function' ||
        account.authority.crypt && (!account.authority.crypt.owner || typeof account.authority.crypt.owner !== 'object' ||
          typeof account.authority.crypt.encrypt !== 'function' || typeof account.authority.crypt.decrypt !== 'function')) {
      this.#lastContext = undefined
      throw stale()
    }
    const capturedAuthority = Object.freeze({ ...account.authority, ...(account.authority.crypt ? { crypt: Object.freeze({ ...account.authority.crypt }) } : {}) })
    this.#lastContext = { persona: account.persona, generation: account.generation, mode: account.mode, authority: capturedAuthority }
    if (this.#foreground.capture()) return { state: 'busy' }
    const epoch = this.#epoch
    const captured = { ...account, authority: capturedAuthority }, selected = room ? Object.freeze({ ...room }) : undefined
    if (selected && (!hex(selected.session) || !hex(selected.rendezvousKey))) throw stale()
    if (network && captured.mode !== 'normal') throw new Error('Grant and witness connections are held in quiet and Tor-only modes.')
    const controller = new AbortController()
    const current = () => {
      const next = this.context()
      return epoch === this.#epoch && !controller.signal.aborted && document.visibilityState === 'visible' &&
        next?.persona === captured.persona && next.generation === captured.generation && next.mode === captured.mode && next.identity?.pubkey === captured.persona &&
        authorityMatches(next.authority, captured.authority)
    }
    await this.#stopping
    if (!current()) return held()
    // Another caller may have entered while this one awaited prior shutdown.
    if (this.#foreground.capture()) return { state: 'busy' }
    this.#controller = controller
    return this.#foreground.run(current, controller.signal, async custody => {
      const scope = this.#foreground.capture()!
      const check = () => { if (!scope.current() || !current()) throw stale() }
      const signerWork = <V>(invoke: () => Promise<V>) => this.#foreground.track(scope, async () => { check(); const value = await invoke(); check(); return value })
      const sign = captured.authority.signEvent.bind(captured.authority.owner)
      const identity: ParticipantIdentity = { pubkey: captured.persona, signEvent: template => signerWork(() => sign(template)) }
      const crypt = captured.authority.crypt
      const encrypt = crypt?.encrypt.bind(crypt.owner), decrypt = crypt?.decrypt.bind(crypt.owner)
      const revocation: VmlsRevocationIdentity | undefined = crypt ? { ...identity,
        encrypt: (peer, plaintext) => signerWork(() => encrypt!(peer, plaintext)), decrypt: (peer, ciphertext) => signerWork(() => decrypt!(peer, ciphertext)) } : undefined
      const services = this.#services ??= this.#create(custody)
      services.links.resume()
      const vault = services.vault.context(location.origin, captured.persona)
      const live = () => scope.current() && current() && services.vault.current(vault)
      const active: Active = { account: captured, identity, revocation, current: live, selected,
        inbox: { vault, current: live, foreground: () => document.visibilityState === 'visible' },
        ...(selected ? { room: { vault, rendezvousKey: selected.rendezvousKey, current: live } } : {}) }
      this.#active = active
      try { check(); const result = await work(services, active); check(); return result }
      finally {
        // Do not await foreground settlement here: it includes this callback.
        try { await Promise.all([this.#endpoint.stop(), services.links.pause(), this.#closeSockets()]) }
        finally { if (this.#active === active) this.#active = undefined; if (this.#controller === controller) this.#controller = undefined }
      }
    })
  }
  #create(custody: BrowserMlsGrantCustody): Services {
    const links = new BrowserPersonaLinks(() => !!this.#active?.current() && this.#active.account.mode === 'normal')
    const coordinator = new BrowserPersonaCoordinator(new BrowserMlsPersonaStore(), links.channels)
    const vault = new CoordinatedMlsVault(coordinator, { generation: () => this.#epoch })
    const rooms = new BrowserMlsRoomOperations(coordinator, vault), context = () => this.#active?.inbox
    const admission = new BrowserMlsKeeperAdmission(coordinator, context, vault)
    const ledger = new BrowserMlsGrantLedger(() => this.#active?.current() ? this.#active.identity : undefined, this.#endpoint, custody,
      (record, identity) => this.#endpoint.carrier(record, identity), undefined, undefined, undefined, admission)
    const inbox = new BrowserMlsRevocationInbox(coordinator, custody, context)
    const decisions = new BrowserMlsKeeperDecisions(coordinator, custody, context, undefined, ledger, undefined, ledger)
    const keeper = new BrowserMlsKeeperRequestController(decisions, rooms, ledger, context)
    const member = new BrowserMlsMembershipController(rooms, ledger, () => this.#active?.room, () => this.#active?.selected?.session, () => this.#active?.account.persona)
    return { links, coordinator, vault, rooms, ledger, inbox, decisions, keeper, member }
  }
  #socket(url: string): WebSocket {
    const active = this.#active, scope = this.#foreground.capture()
    if (!active?.current() || active.account.mode !== 'normal' || !scope || !this.#foreground.prepared(scope)) throw stale()
    const socket = new WebSocket(url)
    const ended = new Promise<void>(resolve => socket.addEventListener('close', () => { this.#sockets.delete(socket); resolve() }, { once: true }))
    this.#sockets.set(socket, ended)
    void this.#foreground.track(scope, () => ended).catch(() => {})
    return socket
  }
  async #closeSockets(): Promise<void> {
    const pending = [...this.#sockets.entries()]
    for (const [socket] of pending) socket.close()
    await Promise.all(pending.map(([, ended]) => ended))
  }
}
