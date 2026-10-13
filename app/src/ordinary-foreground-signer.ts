import type { EventTemplate, NostrEvent, SignetSession, SignetSigner, SignerEffectBoundary, SignerCapabilities } from 'signet-login'
import { verifyEventUncached } from '../../src/verify.js'
import type { DeviceStore } from './device-store.js'
import { OrdinaryStateHold, ordinaryUtf8Length, ORDINARY_VALUE_BYTES, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, type OrdinaryScope, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { ORDINARY_SIGNET_KEYS as keys } from './ordinary-signet-snapshot.js'

const HEX = /^[0-9a-f]{64}$/
const SESSION_KEYS = ['pubkey', 'method', 'authEvent', 'bunkerUri', 'bunkerClientSk', 'expiresAt', 'displayName'] as const
export const ORDINARY_SIGNER_EVENT_BYTES = ORDINARY_VALUE_BYTES
const MAX_TAGS = 128, MAX_TAG_PARTS = 32, MAX_TAG_PART_UNITS = 1024
function hold(): never { throw new OrdinaryStateHold() }
const records = (store: DeviceStore) => new Map(store.keys().map(name => [name, store.get(name)!]))
/** Canonical JSON string size without allocating an escaped copy. Lone
 * surrogates are six-byte escapes; valid pairs occupy four UTF-8 bytes. */
function jsonStringBytes(text: string, remaining: number): number {
  let bytes = 2
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x22 || c === 0x5c || [8, 9, 10, 12, 13].includes(c)) bytes += 2
    else if (c < 0x20) bytes += 6
    else if (c < 0x80) bytes++
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += c >= 0xd800 && c <= 0xdfff ? 6 : 3
    if (bytes > remaining) hold()
  }
  if (bytes > remaining) hold()
  return bytes
}
export function captureOrdinarySigningStatement(input: EventTemplate): Required<EventTemplate> {
  // Capture data fields before yielding. Accessor-backed templates are not
  // allowed to run application code during a later authorisation decision.
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) hold()
  const field = (name: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) hold()
    return descriptor.value
  }
  const kind = field('kind'), created_at = field('created_at'), content = field('content'), tags = field('tags')
  if (!Number.isSafeInteger(kind) || kind < 0 || kind > 65535 || !Number.isSafeInteger(created_at) || created_at < 0 ||
      typeof content !== 'string' || content.length > ORDINARY_VALUE_UNITS || !Array.isArray(tags) || tags.length > MAX_TAGS) hold()
  let bytes = JSON.stringify({ kind, created_at, content: '', tags: [] }).length - 2
  bytes += jsonStringBytes(content, ORDINARY_SIGNER_EVENT_BYTES - bytes)
  const copied: string[][] = []
  for (let i = 0; i < tags.length; i++) {
    const row = Object.getOwnPropertyDescriptor(tags, String(i))
    if (!row || !Object.hasOwn(row, 'value') || !Array.isArray(row.value) || row.value.length > MAX_TAG_PARTS) hold()
    const tag = row.value, parts: string[] = []
    bytes += 2 + (i ? 1 : 0)
    for (let j = 0; j < tag.length; j++) {
      const part = Object.getOwnPropertyDescriptor(tag, String(j))
      if (!part || !Object.hasOwn(part, 'value') || typeof part.value !== 'string' || part.value.length > MAX_TAG_PART_UNITS) hold()
      bytes += j ? 1 : 0
      bytes += jsonStringBytes(part.value, ORDINARY_SIGNER_EVENT_BYTES - bytes)
      parts.push(part.value)
    }
    if (bytes > ORDINARY_SIGNER_EVENT_BYTES) hold()
    copied.push(parts)
  }
  return { kind, created_at, content, tags: copied }
}
const statement=captureOrdinarySigningStatement
function frozenEvent<T extends NostrEvent>(event: T): T {
  return Object.freeze({ ...event, tags: Object.freeze(event.tags.map(tag => Object.freeze([...tag]))) }) as unknown as T
}
export function captureOrdinaryForegroundProof(input: NostrEvent): NostrEvent {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) hold()
  const names = Object.getOwnPropertyNames(input), fields = ['kind', 'created_at', 'tags', 'content', 'pubkey', 'id', 'sig']
  if (names.length !== fields.length || names.some(name => !fields.includes(name))) hold()
  const data: Record<string, unknown> = {}
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name)
    if (!field || !Object.hasOwn(field, 'value')) hold()
    data[name] = field.value
  }
  if (typeof data.pubkey !== 'string' || !HEX.test(data.pubkey) || typeof data.id !== 'string' || !HEX.test(data.id) ||
      typeof data.sig !== 'string' || !/^[0-9a-f]{128}$/.test(data.sig)) hold()
  const unsigned = statement(input)
  // Preserve source field order for exact native SDK JSON matching, without
  // retaining its getters, toJSON, cache symbols or tag aliases.
  return Object.fromEntries(names.map(name => [name, Object.hasOwn(unsigned, name)
    ? unsigned[name as keyof typeof unsigned] : data[name]])) as unknown as NostrEvent
}
export function captureOrdinaryForegroundSession(input: SignetSession): SignetSession {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) hold()
  const required = ['pubkey', 'method', 'signer', 'authEvent'], optional = ['expiresAt', 'displayName']
  const names = Object.getOwnPropertyNames(input)
  if (required.some(name => !names.includes(name)) || names.some(name => ![...required, ...optional].includes(name))) hold()
  const data: Record<string, unknown> = {}
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name)
    if (!field || !Object.hasOwn(field, 'value')) hold()
    data[name] = field.value
  }
  if (typeof data.pubkey !== 'string' || !HEX.test(data.pubkey) || typeof data.method !== 'string' ||
      !['nip07','bunker','redirect','amber','nsec'].includes(data.method) || !data.signer || typeof data.signer !== 'object' ||
      data.expiresAt !== undefined && (!Number.isSafeInteger(data.expiresAt) || (data.expiresAt as number) < 0) ||
      data.displayName !== undefined && (typeof data.displayName !== 'string' || data.displayName.length > ORDINARY_VALUE_UNITS)) hold()
  const proof = captureOrdinaryForegroundProof(data.authEvent as NostrEvent)
  if (proof.kind !== 21236 || proof.pubkey !== data.pubkey || JSON.stringify(proof).length > ORDINARY_VALUE_UNITS) hold()
  return { ...data, authEvent: proof } as unknown as SignetSession
}
/** Additional trusted native-consumer restrictions; never replaces this
 * signer's own complete image, session, SDK or lifetime checks. */
export interface OrdinaryForegroundConsumer {
  live(): boolean
  validate(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody): void
}
interface Options {
  browser: OrdinaryStateOwner
  tab: OrdinaryStateOwner
  session: SignetSession
  currentSession(): SignetSession | undefined
  generation: number
  currentGeneration(): number
  live(): boolean
  checkClients(): Promise<void>
  stop(): void
}

/** A borrowed SDK signer, bound to one native browser/tab foreground. The
 * original signer owner closes its connection only AFTER this adapter joins.
 * This does not initialise login/connections, guard internal transport frames
 * or expose NIP-46 management. Protected startup must mount it explicitly. */
export class OrdinaryForegroundSigner implements SignetSigner {
  /** Private-field provenance, including refusal of prototype-only forgeries. */
  static isNativeSigner(input:unknown):input is OrdinaryForegroundSigner {
    return typeof input==='object'&&input!==null&&#options in input
  }
  /** Native consumers invoke the captured implementation, never a replaced
   * instance borrowing method supplied through a consent object. */
  static borrowNativeSignEvent(signer:OrdinaryForegroundSigner,input:OrdinaryForegroundConsumer):SignetSigner['signEvent'] {
    if(!OrdinaryForegroundSigner.isNativeSigner(signer))hold()
    const consumer=signer.#captureConsumer(input)
    return Object.freeze((event:EventTemplate,external?:SignerEffectBoundary)=>signer.#signEvent(event,external,consumer))
  }
  readonly pubkey: string
  readonly method: SignetSigner['method']
  readonly capabilities: SignerCapabilities
  readonly nip04?: SignetSigner['nip04']
  readonly nip44?: SignetSigner['nip44']
  readonly session: Readonly<SignetSession>
  readonly #options: Options
  readonly #raw: SignetSigner
  readonly #sign: SignetSigner['signEvent']
  readonly #crypto: { nip04?: SignetSigner['nip04']; nip44?: SignetSigner['nip44'] }
  readonly #methods: { nip04?: NonNullable<SignetSigner['nip04']>; nip44?: NonNullable<SignetSigner['nip44']> }
  readonly #proof: string
  readonly #browserScope: OrdinaryScope
  readonly #tabScope: OrdinaryScope
  readonly #work = new Set<Promise<unknown>>()
  #expected: readonly (string | null)[] | undefined
  #closed = false
  #held = false
  #busy = false
  #bunker: { uri: string; key: Uint8Array; source: Uint8Array } | undefined
  private constructor(options: Options, captured: SignetSession, browser: OrdinaryScope, tab: OrdinaryScope) {
    this.#options = options; this.#browserScope = browser; this.#tabScope = tab
    this.#raw = captured.signer; this.#sign = this.#raw.signEvent
    this.pubkey = captured.pubkey; this.method = captured.method
    this.capabilities = Object.freeze({ ...this.#raw.capabilities })
    this.#proof = JSON.stringify(captured.authEvent)
    this.#crypto = { nip04: this.#raw.nip04, nip44: this.#raw.nip44 }
    this.#methods = { nip04: this.#raw.nip04 && { ...this.#raw.nip04 }, nip44: this.#raw.nip44 && { ...this.#raw.nip44 } }
    for (const family of ['nip04', 'nip44'] as const) if (this.#crypto[family]) {
      const methods = this.#methods[family]!, receiver = this.#crypto[family]!
      this[family] = Object.freeze({
        encrypt: (peer: string, text: string, boundary?: SignerEffectBoundary) => this.#crypt(methods.encrypt, receiver, peer, text, boundary),
        decrypt: (peer: string, text: string, boundary?: SignerEffectBoundary) => this.#crypt(methods.decrypt, receiver, peer, text, boundary),
      })
    }
    this.session = Object.freeze({ pubkey: this.pubkey, method: this.method, signer: this,
      authEvent: frozenEvent(JSON.parse(this.#proof)),
      ...(captured.expiresAt === undefined ? {} : { expiresAt: captured.expiresAt }),
      ...(captured.displayName === undefined ? {} : { displayName: captured.displayName }) })
    if (this.method === 'bunker') {
      const signer = this.#raw as SignetSigner & { bunkerUri?: string; clientSecretKey?: Uint8Array }
      const uri = signer.bunkerUri, key = signer.clientSecretKey
      if (typeof uri !== 'string' || !(key instanceof Uint8Array) || key.length !== 32) hold()
      this.#bunker = { uri, source: key, key: Uint8Array.prototype.slice.call(key) }
    }
  }
  #live = (): boolean => {
    if (this.#closed || this.#held) return false
    try {
      const live = this.#options.live(), generation = this.#options.currentGeneration(), selected = this.#options.currentSession()
      if (!selected || selected !== this.#options.session) return false
      const current = captureOrdinaryForegroundSession(selected)
      const raw = this.#raw
      const valid = live && generation === this.#options.generation && selected === this.#options.session &&
        current.pubkey === this.pubkey && current.method === this.method && current.signer === raw &&
        JSON.stringify(current.authEvent) === this.#proof && current.expiresAt === this.session.expiresAt &&
        current.displayName === this.session.displayName && raw.pubkey === this.pubkey && raw.method === this.method &&
        raw.providerEffectBoundary === 1 && raw.signEvent === this.#sign && raw.capabilities.canSignEvents === true &&
        raw.capabilities.hasNip44 === this.capabilities.hasNip44 &&
        this.#bunkerLive() &&
        (this.session.expiresAt === undefined || Date.now() < this.session.expiresAt) &&
        Date.now() < this.#options.tab.expiresAt && ['nip04', 'nip44'].every(name => {
          const family = name as 'nip04' | 'nip44', value = raw[family], captured = this.#crypto[family], methods = this.#methods[family]
          return value === captured && (!value || value.encrypt === methods!.encrypt && value.decrypt === methods!.decrypt)
        })
      // Selectors and signer getters can revoke/re-enter synchronously.
      return valid && !this.#closed && !this.#held
    } catch { return false }
  }
  #check(): void { if (!this.#live()) hold() }
  #bunkerLive(): boolean {
    if (!this.#bunker) return this.method !== 'bunker'
    const signer = this.#raw as SignetSigner & { bunkerUri?: string; clientSecretKey?: Uint8Array }, captured = this.#bunker
    return signer.bunkerUri === captured.uri && signer.clientSecretKey === captured.source && captured.source.length === 32 &&
      captured.key.every((byte, index) => captured.source[index] === byte)
  }
  #stop(): void {
    if (!this.#held) {
      this.#held = true; this.#bunker?.key.fill(0); this.#bunker = undefined; this.#expected = undefined
      try { this.#options.stop() } catch { /* Held still revokes every effect. */ }
    }
  }
  #track<T>(work: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(work)
    OrdinaryStateOwner.joinPairLifetime(this.#options.browser, this.#options.tab, pending)
    this.#work.add(pending); void pending.finally(() => this.#work.delete(pending)).catch(() => {})
    return pending
  }
  async #clients(): Promise<void> { this.#check(); await this.#options.checkClients(); this.#check() }
  #read<T>(work: () => T, consumer?: OrdinaryForegroundConsumer): Promise<T> {
    return OrdinaryStateOwner.readPairMigrated({
      browser: { owner: this.#options.browser, scope: this.#browserScope },
      tab: { owner: this.#options.tab, scope: this.#tabScope }, live: this.#live,
      work: (b, t, _bn, _tn, custody) => {
        this.#preflight(b,t,custody);this.#check()
        if(consumer) {
          if(consumer.live()!==true)hold()
          const checked:unknown=consumer.validate(b,t,custody)
          if(checked&&typeof (checked as PromiseLike<unknown>).then==='function') {void Promise.resolve(checked).catch(()=>{});hold()}
          this.#check();if(consumer.live()!==true)hold()
          // A trusted extra restriction cannot weaken the base decision by
          // changing the callback's stores or re-entering its selectors.
          this.#preflight(b,t,custody);this.#check()
        }
        const value=work();this.#check();if(consumer&&consumer.live()!==true)hold();return value
      },
    })
  }
  #preflight(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody): void {
    const b = records(browser), t = records(tab)
    try {
      validateOrdinarySnapshot(b, t, { browser: true, tab: true }, captureOrdinarySnapshotContext(b, t, custody))
      const session = SESSION_KEYS.map(name => browser.get(keys[name]))
      if (session[0] !== this.pubkey || session[1] !== this.method || session[2] !== this.#proof ||
          session[5] !== (this.session.expiresAt === undefined ? null : String(this.session.expiresAt)) ||
          session[6] !== (this.session.displayName ?? null)) hold()
      if (this.#expected && session.some((value, index) => value !== this.#expected![index])) hold()
      if (this.#bunker && (session[3] !== this.#bunker.uri ||
          session[4] !== [...this.#bunker.key].map(byte => byte.toString(16).padStart(2, '0')).join(''))) hold()
      this.#expected ??= Object.freeze(session)
    } finally { b.clear(); t.clear() }
  }
  static async open(input: Options): Promise<OrdinaryForegroundSigner> {
    const options = { ...input }
    let state: OrdinaryForegroundSigner | undefined
    try {
      const captured = captureOrdinaryForegroundSession(options.session)
      if (!Number.isSafeInteger(options.generation) || options.generation < 0 ||
          options.browser.purpose !== 'browser' || !/^tab:[0-9a-f]{64}$/.test(options.tab.purpose) ||
          captured.signer.providerEffectBoundary !== 1 || captured.signer.capabilities.canSignEvents !== true ||
          typeof captured.signer.signEvent !== 'function') hold()
      const live = () => options.live() && options.currentSession() === options.session && options.currentGeneration() === options.generation
      if (!live()) hold(); await options.checkClients(); if (!live()) hold()
      // The SDK storage partition uses this same fence on forget. The tab
      // counterpart prevents a forgotten/replaced tab from starting retries.
      const browser = await options.browser.capture('@ordinary-signet', live), tab = await options.tab.capture('@ordinary-signet', live)
      state = new OrdinaryForegroundSigner(options, captured, browser, tab)
      await state.#clients(); await state.#read(() => {}); state.#check()
      return state
    } catch (error) { if (state) { state.#stop(); await state.close() } else { try { options.stop() } catch {} }; throw error }
  }
  #run<T>(capture: () => (boundary: SignerEffectBoundary) => Promise<T>, finish: (value: T) => T, consumer?: OrdinaryForegroundConsumer): Promise<T> {
    let invoke: (boundary: SignerEffectBoundary) => Promise<T>
    // Latch and capture before any caller-owned selector or live callback.
    if (this.#busy || this.#closed || this.#held) { this.#stop(); return Promise.reject(new OrdinaryStateHold()) }
    this.#busy = true
    try { invoke = capture(); this.#check() }
    catch (error) { this.#stop(); this.#busy = false; return Promise.reject(error) }
    return this.#track(async () => {
      let active = true, starting = false, sdk: Promise<T> | undefined
      const boundary: SignerEffectBoundary = Object.freeze({ start: <V>(provider: () => Promise<V>): Promise<V> => {
        if (!active || starting) { this.#stop(); return Promise.reject(new OrdinaryStateHold()) }
        starting = true
        return this.#track(async () => {
          let operation: Promise<V> | undefined
          try {
            await this.#clients()
            await this.#read(() => {
              if (!active) hold()
              // Start synchronously under the fresh native decision. Never
              // return its promise from the locked read callback.
              try { operation = Promise.resolve(provider()) } catch (error) { operation = Promise.reject(error) }
              void operation.catch(() => {})
            },consumer)
            if (!operation) hold()
            const result = await operation
            await this.#clients(); await this.#read(() => { if (!active) hold() },consumer); this.#check()
            return result
          } finally {
            if (operation) await Promise.allSettled([operation])
            starting = false
          }
        })
      } })
      try {
        await this.#clients(); await this.#read(() => {},consumer)
        sdk = Promise.resolve(invoke(boundary)); void sdk.catch(() => {})
        const value = finish(await sdk)
        await this.#clients()
        const result = await this.#read(() => value,consumer)
        this.#check(); return result
      } catch (error) { this.#stop(); throw error }
      finally { active = false; if (sdk) await Promise.allSettled([sdk]); this.#busy = false }
    })
  }
  signEvent(input: EventTemplate, external?: SignerEffectBoundary): Promise<NostrEvent> {
    return this.#signEvent(input,external)
  }
  #signEvent(input: EventTemplate, external?: SignerEffectBoundary, consumer?: OrdinaryForegroundConsumer): Promise<NostrEvent> {
    let captured: EventTemplate
    return this.#run(() => {
      if (external !== undefined) hold()
      captured = statement(input)
      return boundary => this.#sign.call(this.#raw, statement(captured), boundary)
    }, signed => {
      const event = captureOrdinaryForegroundProof(signed)
      if (event.pubkey !== this.pubkey || JSON.stringify(statement(event)) !== JSON.stringify(captured) || !verifyEventUncached(event)) hold()
      return frozenEvent(event)
    },consumer)
  }
  #crypt(method: NonNullable<SignetSigner['nip44']>['encrypt'], receiver: NonNullable<SignetSigner['nip44']>,
    peer: string, text: string, external?: SignerEffectBoundary, consumer?: OrdinaryForegroundConsumer): Promise<string> {
    return this.#run(() => {
      if (external !== undefined || typeof peer !== 'string' || !HEX.test(peer) || typeof text !== 'string') hold()
      ordinaryUtf8Length(text)
      return boundary => method.call(receiver, peer, text, boundary)
    }, value => { if (typeof value !== 'string') hold(); ordinaryUtf8Length(value); return value },consumer)
  }
  /** Narrow this signer for a trusted native component. Its synchronous
   * preflight runs in the SAME authentic read as every actual SDK attempt and
   * final handoff; an earlier asynchronous decision is never a substitute. */
  borrowNip44(input: OrdinaryForegroundConsumer): NonNullable<SignetSigner['nip44']> {
    const consumer=this.#captureConsumer(input)
    if(!this.#crypto.nip44||!this.#methods.nip44)hold()
    const methods=this.#methods.nip44,receiver=this.#crypto.nip44
    return Object.freeze({encrypt:(peer:string,text:string)=>this.#crypt(methods.encrypt,receiver,peer,text,undefined,consumer),
      decrypt:(peer:string,text:string)=>this.#crypt(methods.decrypt,receiver,peer,text,undefined,consumer)})
  }
  /** Borrow signing for a trusted native room/carrier component. The caller
   * supplies an additional synchronous restriction, not an authority proof.
   * It is checked at every SDK provider attempt, including delayed upgrades
   * and retries, and again before releasing the detached signed result. */
  borrowSignEvent(input: OrdinaryForegroundConsumer): SignetSigner['signEvent'] {
    return OrdinaryForegroundSigner.borrowNativeSignEvent(this,input)
  }
  #captureConsumer(input: OrdinaryForegroundConsumer): OrdinaryForegroundConsumer {
    if(!input||Object.getPrototypeOf(input)!==Object.prototype)hold()
    const names=Reflect.ownKeys(input)
    if(names.length!==2||names.some(name=>name!=='live'&&name!=='validate'))hold()
    const fields=['live','validate'].map(name=>Object.getOwnPropertyDescriptor(input,name))
    if(fields.some(field=>!field||!Object.hasOwn(field,'value')))hold()
    const live=fields[0]!.value as OrdinaryForegroundConsumer['live'],validate=fields[1]!.value as OrdinaryForegroundConsumer['validate']
    if(typeof live!=='function'||typeof validate!=='function')hold()
    return Object.freeze({live:()=>live.call(input),validate:(b:DeviceStore,t:DeviceStore,c:OrdinaryPairCustody)=>validate.call(input,b,t,c)})
  }
  revoke(): void { this.#closed = true }
  async close(): Promise<void> {
    this.revoke()
    // A boundary can add its own work after the outer call first yielded.
    while (this.#work.size) await Promise.allSettled([...this.#work])
    this.#expected = undefined
    this.#bunker?.key.fill(0); this.#bunker = undefined
  }
}
