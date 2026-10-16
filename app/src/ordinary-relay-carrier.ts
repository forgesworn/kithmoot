import type { Event as NostrEvent } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { NostrRelayPool, normaliseRelayConfig, SUBSCRIBE_EOSE_DEADLINE_MS, type RelayConfig, type RelayTransport } from '../../src/relay-pool.js'
import type { RelayAuthentication } from '../../src/relay-auth.js'
import type { NetworkProfile } from '../../src/anonymous.js'
import type { DeviceStore } from './device-store.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, ordinaryPairReadCustodyFor, type OrdinaryScope, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { OrdinaryForegroundSigner, captureOrdinarySigningStatement } from './ordinary-foreground-signer.js'
import { signOrdinaryVisitorAuthentication } from './ordinary-participant-signing.js'
import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { enterOrdinaryProtocolScope, ownOrdinaryProtocolWork, taskOrdinaryProtocolComponent, observeOrdinaryProtocolComponent, ordinaryProtocolComponentSuspended, type OrdinaryProtocolWork } from './ordinary-protocol-work.js'
import { takeOrdinaryPrivateCarrierClaim, type OrdinaryPrivateCarrierClaim } from './ordinary-persistent-bootstrap.js'

export const ORDINARY_RELAY_FRAME_BYTES = 2 * 1024 * 1024
export const ORDINARY_RELAY_QUEUE_BYTES = 8 * 1024 * 1024
export const ORDINARY_RELAY_QUEUE_FRAMES = 256
function hold(): never { throw new OrdinaryStateHold() }
function records(store: DeviceStore): Map<string, string> { return new Map(store.keys().sort().map(name => [name, store.get(name)!])) }
function dataField(input: object, name: string): unknown {
  const field = Object.getOwnPropertyDescriptor(input, name)
  if (!field || !Object.hasOwn(field, 'value')) hold()
  return field.value
}
function captureEvent(input: NostrEvent): NostrEvent {
  const statement = captureOrdinarySigningStatement(input), pubkey = dataField(input, 'pubkey'), id = dataField(input, 'id'), sig = dataField(input, 'sig')
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey) || typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id) ||
      typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig)) hold()
  return { ...statement, pubkey, id, sig }
}
function captureFilters(input: Filter[]): Filter[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 128) hold()
  const copied: Filter[] = []
  let parts = 0
  for (let index = 0; index < input.length; index++) {
    const filter = dataField(input, String(index))
    if (!filter || typeof filter !== 'object' || Object.getPrototypeOf(filter) !== Object.prototype) hold()
    const result: Record<string, string | number | string[] | number[]> = {}
    for (const key of Reflect.ownKeys(filter)) {
      if (typeof key !== 'string' || !/^(ids|authors|kinds|since|until|limit|search|#[a-zA-Z])$/.test(key)) hold()
      const value = dataField(filter, key)
      if (['since', 'until', 'limit'].includes(key)) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) hold()
        result[key] = value
      } else if (key === 'search') {
        if (typeof value !== 'string') hold()
        ordinaryUtf8Length(value, 4096); result[key] = value
      } else {
        if (!Array.isArray(value) || (parts += value.length) > 8192) hold()
        const array: (string | number)[] = []
        for (let n = 0; n < value.length; n++) {
          const part = dataField(value, String(n))
          if (key === 'kinds') { if (typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0 || part > 65535) hold() }
          else { if (typeof part !== 'string') hold(); ordinaryUtf8Length(part, 4096) }
          array.push(part as string | number)
        }
        result[key] = array as string[] | number[]
      }
    }
    copied.push(result as Filter)
  }
  ordinaryUtf8Length(JSON.stringify(copied), ORDINARY_RELAY_FRAME_BYTES)
  return copied
}
function filterPlan(filters: Filter[]): string {
  return JSON.stringify(filters.map(filter => Object.fromEntries(Object.entries(filter).sort(([a], [b]) => a.localeCompare(b)))))
}
interface SubscriptionReceipt {
  readonly plan: string
  readonly filters: Filter[]
  readonly onEvent: (event: NostrEvent, via?: string) => void
  readonly onEose?: () => void
  readonly seen: Set<string>
  readonly bindings: Map<string, { socket: object; id: string; eosed: boolean }>
  stop?: () => void
  eoseSent: boolean
  deadlineAt?: number
  active: boolean
}
interface PublicationReceipt {
  readonly id: string
  readonly generation: number
  readonly bytes: number
  readonly sent: Set<{ socket: object; raw: WebSocket; pending: boolean }>
  scope?: ProtocolExecution
}
declare const successorBrand: unique symbol
export interface OrdinaryCarrierSuccessor { readonly [successorBrand]: true }
const successors = new WeakMap<object, { owner: OrdinaryRelayCarrier; root: ProtocolExecution; previous: string; next: string;
  generation: number; token?: OrdinaryPairCustody }>()

interface Options {
  /** Ownership only. The actual carrier keeps its native custody predicate. */
  readonly work?: OrdinaryProtocolWork
  readonly browser: OrdinaryStateOwner
  readonly tab: OrdinaryStateOwner
  readonly scope: string
  readonly relays: readonly (string | RelayConfig)[]
  readonly profile: NetworkProfile
  readonly websocketImplementation: typeof WebSocket
  readonly account: string | null
  readonly participant: string
  readonly authentication?: readonly RelayAuthentication[]
  readonly live: () => boolean
  /** Additional current-room/proof restriction, on this exact native read.
   * It supplies no replacement for native custody or complete composition. */
  readonly validate: (browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody) => void
  /** Synchronous notification for an embedding that owns this carrier. It
   * must revoke private protocol work too; it grants no execution authority. */
  readonly onClose?: () => void
}
type CarrierOptions = Omit<Options, 'browser' | 'tab' | 'scope'>
type PrivateCarrierBinding = ReturnType<typeof takeOrdinaryPrivateCarrierClaim>
declare const privateCarrierResourceBrand: unique symbol
export interface OrdinaryPrivateCarrierResource { readonly [privateCarrierResourceBrand]: true }
const privateCarrierPermits = new WeakMap<object, PrivateCarrierBinding>()
const privateCarrierResources = new WeakMap<object, Readonly<{state: OrdinaryRelayCarrier; completed: Promise<void>; transport: RelayTransport}>>()
let constructPrivateCarrier!: (binding: PrivateCarrierBinding) => OrdinaryPrivateCarrierResource
let stopPrivateCarrier!: (resource: OrdinaryPrivateCarrierResource) => void
let closePrivateCarrier!: (resource: OrdinaryPrivateCarrierResource) => Promise<void>
/** The fixed bootstrap consumer spends the genuine claim synchronously. */
export function openOrdinaryPrivateCarrierFromBootstrapClaim(claim: OrdinaryPrivateCarrierClaim): OrdinaryPrivateCarrierResource {
  const binding = takeOrdinaryPrivateCarrierClaim(claim)
  return constructPrivateCarrier(binding)
}
export function ordinaryPrivateCarrierCompleted(resource: OrdinaryPrivateCarrierResource): Promise<void> {
  const value = privateCarrierResources.get(resource); if (!value) hold(); return value.completed
}
export function ordinaryPrivateCarrierTransport(resource: OrdinaryPrivateCarrierResource): RelayTransport {
  const value = privateCarrierResources.get(resource); if (!value) hold(); return value.transport
}
export const stopOrdinaryPrivateCarrier = (resource: OrdinaryPrivateCarrierResource): void => stopPrivateCarrier(resource)
export const closeOrdinaryPrivateCarrier = (resource: OrdinaryPrivateCarrierResource): Promise<void> => closePrivateCarrier(resource)

/** A bounded asynchronous carrier for the real NostrRelayPool. Its immutable
 * configuration and acknowledged full source image are held for its lifetime.
 * This is a carrier custody boundary, not current room/MLS membership. */
export class OrdinaryRelayCarrier implements RelayTransport {
  /** Native-factory preparation only. The route-facing transport exposes none
   * of these controls. No authority is supplied by the projected image. */
  static prepareSuccessor(owner: OrdinaryRelayCarrier, root: ProtocolExecution,
    image: { browser: readonly (readonly [string,string])[]; tab: readonly (readonly [string,string])[]; browserRevision: number; tabRevision: number }): OrdinaryCarrierSuccessor {
    owner.#options.work!.checkTransition(root)
    if (owner.#closed || !owner.#paused || owner.#queuedFrames || owner.#publications.size || owner.#image === undefined) hold()
    const plan = Object.freeze({}) as OrdinaryCarrierSuccessor
    successors.set(plan, { owner, root, previous: owner.#image,
      next: JSON.stringify([image.browser, image.tab, image.browserRevision, image.tabRevision]), generation: owner.#generation })
    return plan
  }
  static checkSuccessor(owner: OrdinaryRelayCarrier, plan: OrdinaryCarrierSuccessor, browser: DeviceStore, tab: DeviceStore, token: OrdinaryPairCustody): void {
    const data = successors.get(plan)
    if (!data || data.owner !== owner || owner.#closed || !owner.#paused || owner.#image !== data.previous || owner.#generation !== data.generation ||
        owner.#queuedFrames || owner.#publications.size) hold()
    owner.#options.work!.checkTransition(data.root)
    owner.#checkBinding(browser, tab, token)
    const b = records(browser), t = records(tab)
    try {
      const headers = ordinaryPairReadCustodyFor(token, b, t)
      validateOrdinarySnapshot(b, t, { browser: true, tab: true }, captureOrdinarySnapshotContext(b, t, token))
      if (JSON.stringify([[...b], [...t], headers.browser.revision, headers.tab.revision]) !== data.next) hold()
      data.token = token
    } finally { b.clear(); t.clear() }
  }
  /** Pure assignments after the complete successor check, in the same native
   * callback. No selector or application callback runs during the guard swap. */
  static applySuccessor(owner: OrdinaryRelayCarrier, plan: OrdinaryCarrierSuccessor, token: OrdinaryPairCustody): void {
    const data = successors.get(plan)
    if (!data || data.owner !== owner || data.token !== token || owner.#closed || !owner.#paused ||
        owner.#image !== data.previous || owner.#generation !== data.generation) hold()
    successors.delete(plan); owner.#image = data.next
  }
  /** Resource restart is separately owned by a new generation and takes a
   * fresh native read after all successor views have been adopted. */
  static async resumeSuccessor(owner: OrdinaryRelayCarrier, scope: ProtocolExecution): Promise<void> {
    await owner.#read(() => {}, scope)
  }
  readonly #options: CarrierOptions
  readonly #legacy: Options | undefined
  readonly #private: PrivateCarrierBinding | undefined
  readonly #browserScope: OrdinaryScope | undefined
  readonly #tabScope: OrdinaryScope | undefined
  readonly #relays: readonly RelayConfig[]
  readonly #work = new Set<Promise<unknown>>()
  readonly #sockets = new Set<{ close(): void }>()
  readonly #signing = new Map<object, Promise<unknown>>()
  readonly #subscriptions = new Set<SubscriptionReceipt>()
  readonly #publications = new Map<string, PublicationReceipt>()
  #publicationBytes = 0
  #generation = 0
  #paused = false
  #resumeRequested = false
  #stopSuspension?: () => void
  #pool: NostrRelayPool | undefined
  #releaseResource: (() => void) | undefined
  #image: string | undefined
  #closed = false
  #queuedBytes = 0
  #queuedFrames = 0
  #opening: Promise<void> | undefined
  static {
    constructPrivateCarrier = binding => this.#constructPrivate(binding)
    stopPrivateCarrier = resource => {
      const value = privateCarrierResources.get(resource); if (!value) hold(); value.state.#close()
    }
    closePrivateCarrier = async resource => {
      const value = privateCarrierResources.get(resource); if (!value) hold()
      value.state.#close(); await value.completed.catch(() => {}); await value.state.#joinLifetime()
    }
  }
  private constructor(construction: {kind: 'legacy'; options: Options; browser: OrdinaryScope; tab: OrdinaryScope; relays: readonly RelayConfig[]} |
    {kind: 'private'; permit: object}) {
    if (construction.kind === 'private') {
      const binding = privateCarrierPermits.get(construction.permit); privateCarrierPermits.delete(construction.permit)
      if (!binding || !binding.live() || binding.account !== binding.participant || !/^[0-9a-f]{64}$/.test(binding.participant)) hold()
      // This existing account path is fixed to direct signed destinations.
      // AUTH is deliberately absent: no participant signing endpoint exists.
      const relays = normaliseRelayConfig(binding.relays, 'direct')
      if (!relays.length || relays.length !== binding.relays.length || relays.some((relay, index) =>
        relay.circle || !relay.read || !relay.write || relay.url !== binding.relays[index])) hold()
      this.#private = binding; this.#legacy = undefined; this.#browserScope = undefined; this.#tabScope = undefined
      this.#relays = Object.freeze(relays.map(relay => Object.freeze({...relay})))
      this.#options = Object.freeze({relays: binding.relays, profile: 'direct', websocketImplementation: binding.websocketImplementation,
        account: binding.account, participant: binding.participant,
        live: binding.live, validate: binding.validate, onClose: binding.revoke})
      return
    }
    this.#private = undefined; this.#legacy = construction.options
    this.#options = construction.options; this.#browserScope = construction.browser
    this.#tabScope = construction.tab; this.#relays = construction.relays
  }
  #legacyBinding() {
    if (!this.#legacy || this.#private || !this.#browserScope || !this.#tabScope) hold()
    return {browser: {owner: this.#legacy.browser, scope: this.#browserScope},
      tab: {owner: this.#legacy.tab, scope: this.#tabScope}, live: this.#live}
  }
  #checkBinding(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody): void {
    if (this.#private) this.#private.validate(browser, tab, custody)
    else OrdinaryStateOwner.validatePairBinding(custody, this.#legacyBinding())
  }
  static #constructPrivate(binding: PrivateCarrierBinding): OrdinaryPrivateCarrierResource {
    const permit = Object.freeze({}); privateCarrierPermits.set(permit, binding)
    let state: OrdinaryRelayCarrier
    try { state = new OrdinaryRelayCarrier({kind: 'private', permit}) }
    finally { privateCarrierPermits.delete(permit) }
    let resolve!: () => void, reject!: (error: unknown) => void
    const completed = new Promise<void>((yes, no) => {resolve = yes; reject = no})
    state.#opening = completed
    const resource = Object.freeze({}) as OrdinaryPrivateCarrierResource
    const transport: RelayTransport = Object.freeze(Object.assign(Object.create(null) as RelayTransport, {publish: (event: NostrEvent) => state.#publish(event),
      subscribe: (filters: Filter[], onEvent: (event: NostrEvent, via?: string) => void, onEose?: () => void) => state.#subscribe(filters, onEvent, onEose),
      close: () => state.#close()}))
    privateCarrierResources.set(resource, Object.freeze({state, completed, transport}))
    // Publication precedes the body. Failure drains inner jobs only: joining
    // completed here would make this opening wait for itself.
    void Promise.resolve().then(async () => {
      try {
        await state.#read((b, t, c) => {
          if (!state.#live() || state.#paused) hold()
          state.#pool = new NostrRelayPool(state.#relays, undefined, {profile: 'direct', websocketImplementation: state.#websocket(),
            authentication: [], ownBackground: body => state.#track(ownOrdinaryProtocolWork(binding.control, async () => {await body()}))})
          state.#stopSuspension = observeOrdinaryProtocolComponent(binding.control, paused => {
            if (paused) state.#suspend(); else state.#resumeRequested = true
          })
          state.#releaseResource = binding.retainResource(b, t, c, {revoke: () => state.#close(), join: () => state.#joinLifetime()})
        })
      } catch { state.#close(); await state.#joinLifetime(); throw new OrdinaryStateHold() }
    }).then(resolve, reject).catch(() => {})
    void completed.catch(() => {})
    return resource
  }
  static async open(input: Options): Promise<OrdinaryRelayCarrier> {
    let owner: OrdinaryRelayCarrier | undefined
    try {
      const options = { ...input }, relays = normaliseRelayConfig(options.relays, options.profile)
      if (!/^[0-9a-f]{64}$/.test(options.participant) || options.account !== null && options.account !== options.participant ||
          typeof options.live !== 'function' || typeof options.validate !== 'function' || typeof options.websocketImplementation !== 'function' ||
          Object.getPrototypeOf(options.validate) === Object.getPrototypeOf(async () => {})) hold()
      const grants = (options.authentication ?? []).map(value => ({ url: value.url, identity: value.identity }))
      if (options.profile === 'tor' && grants.length) hold()
      const seen = new Set<string>()
      for (const grant of grants) {
        const url = normaliseRelayConfig([grant.url], options.profile)[0]!.url
        if (!relays.some(relay => relay.url === url) || seen.has(url) || grant.identity === null ||
            grant.identity.pubkey !== options.participant || options.account !== null && !OrdinaryForegroundSigner.isNativeSigner(grant.identity)) hold()
        grant.url = url; seen.add(url)
      }
      const browser = await options.browser.capture(options.scope, options.live), tab = await options.tab.capture(options.scope, options.live)
      owner = new OrdinaryRelayCarrier({kind: 'legacy', options, browser, tab, relays})
      const state = owner, websocketImplementation = state.#websocket()
      await state.#read((_b, _t, custody) => {
        const authentication: RelayAuthentication[] = grants.map(grant => ({ url: grant.url, identity: {
          pubkey: options.participant, signEvent: template => state.#authenticate(grant.identity!, grant.url, template),
        } }))
        if (state.#paused) hold()
        state.#pool = new NostrRelayPool(relays, undefined, { profile: options.profile, websocketImplementation, authentication,
          ...(options.work ? { ownBackground: (body: () => Promise<void>) => state.#track(options.work!.own(async () => { await body() })) } : {}) })
        state.#stopSuspension = options.work?.execution.onSuspend?.(paused => {
          if (paused) state.#suspend()
          else state.#resumeRequested = true // cleanup listener starts no work
        })
        state.#releaseResource = OrdinaryStateOwner.retainPairResource(custody, {
          browser: { owner: options.browser, scope: browser }, tab: { owner: options.tab, scope: tab }, live: state.#live,
        }, { revoke: () => state.#close(), join: () => state.#joinLifetime() })
      })
      return state
    } catch (error) { if (owner) { owner.#close(); await owner.#joinLifetime() }; throw error }
  }
  #live = (): boolean => {
    if (this.#closed) return false
    const current = this.#options.live()
    return current === true && !this.#closed && (this.#private !== undefined || Date.now() < this.#legacy!.tab.expiresAt)
  }
  #track<T>(job: Promise<T>): Promise<T> {
    if (this.#private) this.#private.join(job)
    else OrdinaryStateOwner.joinPairLifetime(this.#legacy!.browser, this.#legacy!.tab, job)
    this.#work.add(job); void job.finally(() => this.#work.delete(job)).catch(() => {}); return job
  }
  #validate(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody): void {
    const check = () => this.#checkBinding(browser, tab, custody)
    check()
    const b = records(browser), t = records(tab)
    try {
      const headers = ordinaryPairReadCustodyFor(custody, b, t)
      validateOrdinarySnapshot(b, t, { browser: true, tab: true }, captureOrdinarySnapshotContext(b, t, custody))
      const image = JSON.stringify([[...b], [...t], headers.browser.revision, headers.tab.revision])
      if (this.#image !== undefined && this.#image !== image) hold()
      if (this.#options.validate(browser, tab, custody) !== undefined) hold()
      // Trusted room checks may synchronously revoke the owner or selection.
      check()
      if (this.#image === undefined) this.#image = image
    } finally { b.clear(); t.clear() }
  }
  #read<T>(effect: (browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody) => T, scope?: ProtocolExecution): Promise<T> {
    const graph = this.#options.work
    if (this.#private && !scope) {
      let result: T
      return taskOrdinaryProtocolComponent(this.#private.control, 'relay-read', async owned => {result = await this.#read(effect, owned)}).then(() => result!)
    }
    if (graph && !scope) return graph.execution.task!('relay-read', owned => this.#read(effect, owned))
    const work = (b: DeviceStore, t: DeviceStore, custody: OrdinaryPairCustody) => {
        this.#validate(b, t, custody)
        const run = () => { if (this.#resumeRequested) this.#resumeResources(); return effect(b, t, custody) }
        const result = this.#private ? enterOrdinaryProtocolScope(this.#private.control, scope!, 'relay-read', run) : graph ? graph.enter(scope!, 'relay-read', run) : run()
        this.#validate(b, t, custody)
        return result
      }
    const pending = this.#private ? this.#private.read(this.#live, work) : OrdinaryStateOwner.readPairMigrated({
      ...this.#legacyBinding(), work: (b, t, _bn, _tn, c) => work(b, t, c)})
    const job = pending.catch(error => { this.#close(); throw error })
    return this.#track(job)
  }
  #enqueue(bytes: number, effect: () => void, tail: Promise<void>, ackScope?: ProtocolExecution): Promise<void> {
    try {
      if (this.#closed || this.#queuedFrames + 1 > ORDINARY_RELAY_QUEUE_FRAMES ||
          this.#queuedBytes + bytes > ORDINARY_RELAY_QUEUE_BYTES) hold()
    } catch { this.#close(); return Promise.resolve() }
    this.#queuedFrames++; this.#queuedBytes += bytes
    // Register before waiting for the queue tail. An already queued callback
    // must not appear as new work on the far side of a suspension latch.
    const run = async (scope?: ProtocolExecution) => { if (!this.#live()) hold(); await tail; await this.#read(effect, scope) }
    const pending = ackScope?.task ? ackScope.task('old-relay-ack', run) : this.#private ? ownOrdinaryProtocolWork(this.#private.control, run) : this.#options.work ? this.#options.work.own(run) : run()
    const job = pending.catch(() => { this.#close() }).finally(() => {
      this.#queuedFrames--; this.#queuedBytes -= bytes
    })
    return this.#track(job)
  }
  #websocket(): typeof WebSocket {
    const owner = this, Base = this.#options.websocketImplementation, destinations = new Set(this.#relays.map(relay => relay.url))
    // nostr-tools consumes callbacks, readyState, send and close. Extending
    // Base would dial before an asynchronous native read could authorise it.
    class Socket {
      static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3
      readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3
      readonly url: string
      readonly #socketGeneration = owner.#generation
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      #socket: WebSocket | undefined
      #stopped = false
      #notifiedClose = false
      #tail = Promise.resolve()
      get readyState(): number { return this.#stopped ? 3 : this.#socket?.readyState ?? 0 }
      constructor(url: string) {
        this.url = url
        if (owner.#paused || !destinations.has(url) || !owner.#live() || owner.#sockets.size >= owner.#relays.length * 4) { owner.#close(); hold() }
        owner.#sockets.add(this)
        this.#queue(0, () => {
          if (this.#stopped || owner.#paused || this.#socketGeneration !== owner.#generation) return
          const socket = new Base(url); this.#socket = socket
          socket.onopen = () => this.#queue(0, () => this.onopen?.(new Event('open')))
          socket.onmessage = message => {
            try {
              if (this.#stopped || this.#socketGeneration !== owner.#generation) return
              const data = message.data
              if (owner.#paused && (typeof data !== 'string' || !/^\s*\[\s*"OK"\s*,/.test(data))) return
              if (typeof data !== 'string') hold()
              const bytes = ordinaryUtf8Length(data, ORDINARY_RELAY_FRAME_BYTES)
              // Post-latch observations cannot acquire a new root. Claim
              // only one exact ACK for a successfully sent old EVENT on this
              // raw socket/destination/generation and its still-owned tail.
              let frame: unknown, ackScope: ProtocolExecution | undefined, claimed = false
              if (/^\s*\[\s*"OK"\s*,/.test(data)) {
                try { frame = JSON.parse(data) } catch { if (owner.#paused) return; throw new OrdinaryStateHold() }
                const receipt = this.#ack(frame)
                claimed = receipt !== undefined
                if (owner.#paused) {
                  if (!receipt || (owner.#private || owner.#options.work) && !receipt.scope) return
                  ackScope = receipt.scope
                }
              }
              this.#queue(bytes, () => {
                frame ??= JSON.parse(data)
                if (!claimed) this.#ack(frame)
                if (Array.isArray(frame) && frame.length === 2 && frame[0] === 'EOSE' && typeof frame[1] === 'string') {
                  for (const subscription of owner.#subscriptions) {
                    const binding = subscription.bindings.get(url)
                    if (subscription.active && binding?.socket === this && binding.id === frame[1]) binding.eosed = true
                  }
                }
                this.onmessage?.(new MessageEvent('message', { data }))
              }, ackScope)
            } catch { owner.#close() }
          }
          socket.onerror = () => { if (!owner.#paused) this.#queue(0, () => this.onerror?.(new Event('error'))) }
          socket.onclose = () => {
            if (owner.#paused) this.close()
            else this.#queue(0, () => { this.#notifyClose(new CloseEvent('close')); this.close() })
          }
        })
      }
      #ack(frame: unknown): PublicationReceipt | undefined {
        if (!Array.isArray(frame) || frame.length !== 4 || frame[0] !== 'OK' || typeof frame[1] !== 'string' ||
            typeof frame[2] !== 'boolean' || typeof frame[3] !== 'string') return
        const publication = owner.#publications.get(frame[1])
        if (!publication || publication.generation !== this.#socketGeneration) return
        for (const receipt of publication.sent) if (receipt.pending && receipt.socket === this && receipt.raw === this.#socket) {
          receipt.pending = false; return publication
        }
      }
      #queue(bytes: number, effect: () => void, ackScope?: ProtocolExecution): void {
        if (this.#stopped || this.#socketGeneration !== owner.#generation || owner.#paused && !ackScope) return
        this.#tail = owner.#enqueue(bytes, () => { if (!this.#stopped && this.#socketGeneration === owner.#generation) effect() }, this.#tail, ackScope)
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (this.#stopped || owner.#paused || this.#socketGeneration !== owner.#generation) return
        try {
          if (typeof data !== 'string') hold()
          const bytes = ordinaryUtf8Length(data, ORDINARY_RELAY_FRAME_BYTES)
          const frame: unknown = JSON.parse(data)
          if (!Array.isArray(frame) || !['REQ', 'EVENT', 'AUTH', 'CLOSE'].includes(frame[0])) hold()
          this.#queue(bytes, () => {
            if (owner.#paused || this.#socketGeneration !== owner.#generation) return
            if (this.#socket?.readyState !== 1) hold()
            if (frame[0] === 'REQ') {
              if (typeof frame[1] !== 'string') hold()
              const plan = filterPlan(captureFilters(frame.slice(2)))
              for (const subscription of owner.#subscriptions) if (subscription.active && subscription.plan === plan) {
                subscription.bindings.set(this.url, { socket: this, id: frame[1], eosed: false })
              }
            }
            this.#socket.send(data)
            if (frame[0] === 'EVENT' && !owner.#paused && this.#socketGeneration === owner.#generation) {
              const publication = owner.#publications.get((frame[1] as NostrEvent)?.id)
              if (publication && publication.generation === this.#socketGeneration) publication.sent.add({ socket: this, raw: this.#socket, pending: true })
            }
          })
        } catch { owner.#close() }
      }
      #notifyClose(event: CloseEvent): void {
        if (this.#notifiedClose) return
        this.#notifiedClose = true; this.onclose?.(event)
      }
      close(): void {
        if (this.#stopped) return
        this.#stopped = true; owner.#sockets.delete(this)
        // Cancellation closes without sending a protocol CLOSE after custody
        // has ended. Queued callbacks and frames cannot escape afterwards.
        try { this.#socket?.close() } catch { /* already unavailable */ }
        // Notify only cancellation, without dispatching an incoming frame.
        // The pool's pending connect/AUTH promises must settle too; dropping
        // this lifecycle signal can strand them behind the dial timeout.
        try { this.#notifyClose(new CloseEvent('close', { code: 1000, reason: 'Native carrier closed', wasClean: true })) }
        catch { /* cancellation still owns no further socket effects */ }
      }
    }
    return Socket as unknown as typeof WebSocket
  }
  #authenticate(identity: NonNullable<RelayAuthentication['identity']>, url: string, input: Parameters<NonNullable<RelayAuthentication['identity']>['signEvent']>[0]): Promise<NostrEvent> {
    if (this.#private) return Promise.reject(new OrdinaryStateHold()) // No private AUTH capability.
    let canonical: ReturnType<typeof captureOrdinarySigningStatement>
    try { canonical = captureOrdinarySigningStatement(input) } catch { this.#close(); return Promise.reject(new OrdinaryStateHold()) }
    const previous = this.#signing.get(identity) ?? Promise.resolve()
    const run = async (scope?: ProtocolExecution) => {
      await previous
      if (this.#paused) throw new Error('Relay authentication is suspended.')
      const challenge = canonical.tags[1]?.[1]
      if (canonical.kind !== 22242 || canonical.content !== '' || canonical.tags.length !== 2 ||
          JSON.stringify(canonical.tags[0]) !== JSON.stringify(['relay', url]) || canonical.tags[1]?.length !== 2 ||
          canonical.tags[1]?.[0] !== 'challenge' || !challenge || challenge.length > 1024) hold()
      let signing: Promise<NostrEvent> | undefined
      try {
        await this.#read((b, t, c) => {
          if (this.#options.account === null) signing = Promise.resolve(signOrdinaryVisitorAuthentication(b, t, c,
            { account: null, participant: this.#options.participant, url, challenge, createdAt: canonical.created_at }, canonical))
          else {
            if (!OrdinaryForegroundSigner.isNativeSigner(identity)) hold()
            signing = OrdinaryForegroundSigner.borrowNativeSignEvent(identity, { live: this.#live,
              validate: (b, t, c) => {
                this.#validate(b, t, c)
                if (this.#private) enterOrdinaryProtocolScope(this.#private.control, scope!, 'relay-auth-provider', () => {})
                else if (this.#options.work) this.#options.work.enter(scope!, 'relay-auth-provider', () => {})
              } })(canonical)
          }
          void signing.catch(() => {})
        }, scope)
        if (!signing) hold()
        const signed = await signing
        return await this.#read(() => signed, scope)
      } finally { if (signing) await Promise.allSettled([signing]) }
    }
    const owned = this.#options.work ? this.#options.work.execution.task!('relay-auth', run) : run()
    const job = owned.catch(error => { if (!this.#paused) this.#close(); throw error })
    this.#signing.set(identity, job)
    void job.finally(() => { if (this.#signing.get(identity) === job) this.#signing.delete(identity) }).catch(() => {})
    return this.#track(job)
  }
  publish(event: NostrEvent): Promise<void> { return this.#publish(event) }
  #publish(event: NostrEvent): Promise<void> {
    let captured: NostrEvent, bytes: number
    try { captured = captureEvent(event); bytes = ordinaryUtf8Length(JSON.stringify(captured), ORDINARY_RELAY_FRAME_BYTES) }
    catch { this.#close(); return Promise.reject(new OrdinaryStateHold()) }
    const run = async (scope?: ProtocolExecution) => {
      if (this.#paused) throw new Error('Relay publication is suspended.')
      if (this.#publications.has(captured.id)) throw new Error('This exact publication is already pending.')
      if (this.#publications.size >= 128 || this.#publicationBytes + bytes > ORDINARY_RELAY_QUEUE_BYTES) hold()
      const receipt: PublicationReceipt = { id: captured.id, generation: this.#generation, bytes, sent: new Set() }
      this.#publications.set(receipt.id, receipt); this.#publicationBytes += bytes
      let pending: Promise<void> | undefined
      let fanout: Promise<void> | undefined
      try {
      await this.#read(() => {
        const pool = this.#pool!
        pending = pool.publish(captured); void pending.catch(() => {})
        // The public ACK may be the first relay. Keep its entire slower
        // fan-out/retry tail owned by this publication's job graph too.
        const drain = async (owned?: ProtocolExecution) => {
          receipt.scope = owned
          try { while (pool.publishing) await pool.settled() }
          finally { this.#releasePublication(receipt) }
        }
        fanout = this.#private ? ownOrdinaryProtocolWork(this.#private.control, drain) : this.#options.work ? this.#options.work.own(drain) : drain()
        this.#track(fanout); void fanout.catch(() => {})
      }, scope)
      await pending
      await this.#read(() => {}, scope)
      } finally { if (!fanout) this.#releasePublication(receipt) }
    }
    const pending = this.#private ? taskOrdinaryProtocolComponent(this.#private.control, 'relay-publication', run) : this.#options.work ? this.#options.work.execution.task!('relay-publication', run) : run()
    return this.#track(pending.catch(error => { if (this.#closed) hold(); throw error }))
  }
  subscribe(filters: Filter[], onEvent: (event: NostrEvent, via?: string) => void, onEose?: () => void): () => void { return this.#subscribe(filters, onEvent, onEose) }
  #subscribe(filters: Filter[], onEvent: (event: NostrEvent, via?: string) => void, onEose?: () => void): () => void {
    if (!this.#relays.some(relay => relay.read)) { this.#close(); return () => {} }
    let captured: Filter[]
    try { captured = captureFilters(filters) }
    catch { this.#close(); return () => {} }
    const subscription: SubscriptionReceipt = { plan: filterPlan(captured), filters: captured, onEvent, onEose,
      seen: new Set(), bindings: new Map(), active: true, eoseSent: false }
    if (this.#subscriptions.size >= 128 || [...this.#subscriptions].some(value => value.plan === subscription.plan)) {
      this.#close(); return () => {}
    }
    this.#subscriptions.add(subscription)
    void this.#read(() => {
      if (subscription.active && !this.#paused && !subscription.stop) this.#bindSubscription(subscription)
    }).catch(() => {})
    return () => { subscription.active = false; this.#subscriptions.delete(subscription); subscription.stop?.(); subscription.stop = undefined }
  }
  #bindSubscription(subscription: SubscriptionReceipt): void {
    const generation = this.#generation
    // Old queued handoffs retain their original binding evidence through
    // the drain. Clear it only when binding this fresh generation.
    subscription.bindings.clear()
    let tail = Promise.resolve()
    const current = () => subscription.active && generation === this.#generation && !this.#closed
    const deliver = (bytes: number, effect: () => void) => {
      if (!current() || this.#paused) return
      tail = this.#enqueue(bytes, () => { if (current()) effect() }, tail)
    }
    subscription.deadlineAt ??= Date.now() + SUBSCRIBE_EOSE_DEADLINE_MS
    subscription.stop = this.#pool!.subscribe(subscription.filters, (event, via) => {
        try { const data = JSON.stringify(event); deliver(ordinaryUtf8Length(data, ORDINARY_RELAY_FRAME_BYTES), () => {
          if (subscription.seen.has(event.id)) return
          subscription.seen.add(event.id)
          if (subscription.seen.size > 8192) subscription.seen.delete(subscription.seen.values().next().value!)
          subscription.onEvent(JSON.parse(data), via)
        }) }
        catch { this.#close() }
      }, subscription.onEose ? () => deliver(0, () => {
        // Both the pool and nostr-tools can report timeout/closed readers as
        // EOSE. Only actual guarded EOSE frames for this exact current REQ
        // at every configured reader can cross the native handoff.
        if (!this.#relays.filter(relay => relay.read).every(relay => subscription.bindings.get(relay.url)?.eosed === true)) hold()
        if (!subscription.eoseSent) { subscription.eoseSent = true; subscription.onEose!() }
      }) : undefined, { deadlineAt: subscription.deadlineAt, loaded: subscription.eoseSent })
  }
  #releasePublication(receipt: PublicationReceipt): void {
    if (this.#publications.get(receipt.id) !== receipt) return
    this.#publications.delete(receipt.id); this.#publicationBytes -= receipt.bytes
    if (this.#paused) this.#prunePausedSockets()
  }
  #hasOwnedPublication(socket: object): boolean {
    for (const publication of this.#publications.values()) if (publication.generation === this.#generation) {
      // A claimed ACK may still be queued behind a native read, or inside
      // the dependency's message-processing microtask. Keep its socket until
      // the full publication tail settles, not merely until ingress claims it.
      for (const receipt of publication.sent) if (receipt.socket === socket) return true
    }
    return false
  }
  #prunePausedSockets(): void {
    for (const socket of [...this.#sockets]) if (!this.#hasOwnedPublication(socket)) socket.close()
  }
  #suspend(): void {
    if (this.#closed || this.#paused) return
    this.#paused = true; this.#resumeRequested = false // latch before cleanup
    // Settle the dependency's pending connect/AUTH before pool cancellation
    // detaches its socket lifecycle callbacks. Sent EVENT tails stay open.
    this.#prunePausedSockets()
    this.#pool?.suspend()
    for (const subscription of this.#subscriptions) {
      subscription.stop?.(); subscription.stop = undefined
    }
    this.#prunePausedSockets()
  }
  #resumeResources(): void {
    if (this.#closed || !this.#paused || (this.#private ? ordinaryProtocolComponentSuspended(this.#private.control) : this.#options.work?.suspended)) hold()
    // The caller's native read has just authenticated the exact selected
    // image. Every old raw callback remains fenced by its fixed generation.
    if (!Number.isSafeInteger(this.#generation + 1)) hold()
    this.#generation++; this.#pool!.resume()
    this.#paused = false; this.#resumeRequested = false
    for (const subscription of this.#subscriptions) if (subscription.active) this.#bindSubscription(subscription)
  }
  /** Internal factory resource wake-up after a guarded graph transition.
   * This method cannot resume the graph or replace its native predicate. */
  resumeResources(): Promise<void> { return this.#read(() => {}) }
  describe(): RelayConfig[] { return this.#describe() }
  #describe(): RelayConfig[] { return this.#relays.map(relay => ({ ...relay })) }
  get closed(): boolean { return this.#closed }
  close(): void { this.#close() }
  #close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#stopSuspension?.(); this.#stopSuspension = undefined
    try { this.#options.onClose?.() } catch { /* the carrier still owns its cleanup */ }
    this.#releaseResource?.(); this.#releaseResource = undefined
    for (const socket of this.#sockets) socket.close()
    this.#sockets.clear(); this.#pool?.close()
    for (const subscription of this.#subscriptions) subscription.active = false
    this.#subscriptions.clear()
    this.#image = undefined
  }
  /** Includes queued reads, publication receipts and unabortable providers.
   * Revoke with close() before awaiting; do not await inside a pair callback. */
  async joinLifetime(): Promise<void> {
    await this.#opening?.catch(() => {})
    await this.#joinLifetime()
  }
  async #joinLifetime(): Promise<void> {
    while (this.#work.size) await Promise.allSettled([...this.#work])
    // publish() acknowledges the first relay; the real pool may still own
    // slower fan-out/retry tails. Closing aborts them, but their promises
    // must settle before the native component reports its lifetime joined.
    if (this.#closed) while (this.#pool?.publishing) await this.#pool.settled()
    await this.#pool?.joinBackground()
  }
}
