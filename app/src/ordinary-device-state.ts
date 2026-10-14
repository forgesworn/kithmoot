import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import type { DeviceCredential } from '../../src/types.js'
import { parseRoomLink } from '../../src/link.js'
import { verifyDeviceCredential } from '../../src/credential.js'
import { credentialSeal } from '../../src/seal.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, type OrdinaryScope } from './ordinary-state-owner.js'
import { DEVICE_PREFIX, CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX, MAX_OWN_SEAL_KEYS,
  deviceKeyFor, loadDeviceKeyFor, loadCredentialFor, loadOwnCredentialFor, loadOwnSealKeysFor,
  storeCredentialFor, storeOwnCredentialFor, type DeviceStore } from './device-store.js'

const HEX = /^[0-9a-f]{64}$/i
function hold(): never { throw new OrdinaryStateHold() }
function object(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === fields.sort().join(',')
}
function secret(value: unknown): string {
  if (typeof value !== 'string' || !HEX.test(value)) hold()
  const bytes = hexToBytes(value)
  try { getPublicKey(bytes); return value } catch { hold() } finally { bytes.fill(0) }
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function wipe(value: Uint8Array | Uint8Array[] | undefined): void {
  if (Array.isArray(value)) for (const key of value) key.fill(0)
  else value?.fill(0)
}
/** Strict ordinary-custody shape and signature checks. Expiration is evaluated
 * separately when deciding whether to resume: expiry cannot erase an unknown
 * retention intent. These records supply no MLS membership authority. */
function credential(value: unknown, roomId: string): DeviceCredential {
  if (!object(value, ['id','pubkey','kind','created_at','tags','content','sig']) ||
      typeof value.id !== 'string' || !HEX.test(value.id) || typeof value.pubkey !== 'string' || !HEX.test(value.pubkey) ||
      !integer(value.kind) || !integer(value.created_at) || typeof value.content !== 'string' || value.content.length > 4096 ||
      typeof value.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(value.sig) || !Array.isArray(value.tags) || value.tags.length > 128 ||
      value.tags.some(tag => !Array.isArray(tag) || tag.length > 32 || tag.some(part => typeof part !== 'string' || part.length > 1024))) hold()
  const saved = value as unknown as DeviceCredential
  const expiresAt = Number(saved.tags.find(tag => tag[0] === 'expiration')?.[1])
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) hold()
  try {
    if (credentialSeal(saved) === null) hold()
    if (!verifyDeviceCredential(saved, { roomId, now: expiresAt - 1 }).ok) hold()
    return saved
  } catch { hold() }
}

interface Options {
  owner: OrdinaryStateOwner
  account: string
  roomId: string
  /** Current foreground ownership, compared with the original captured terms. */
  current(): { account: string; roomId: string } | undefined
  live(): boolean
}

/** The production-facing device adapter has no arbitrary store writer. Each
 * helper sees only this room's exact device/credential/seal names, and every
 * mutation returns only after the native owner acknowledges its full image.
 * Bootstrap and the complete migration must prepare the owner before opening. */
export class OrdinaryRoomDeviceState {
  readonly #options: Options
  readonly #scope: OrdinaryScope
  readonly #names: Map<string, string>
  readonly #binding: string
  readonly #work = new Set<Promise<unknown>>()
  #closed = false
  private constructor(options: Options, scope: OrdinaryScope) {
    this.#options = options; this.#scope = scope
    const prefix = 'kithmoot.account.' + options.account + '.'
    this.#names = new Map([DEVICE_PREFIX, CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX].map(name => [name + options.roomId, prefix + name + options.roomId]))
    this.#binding = prefix + 'kithmoot.device-owner.' + options.roomId
  }
  static async open(options: Options): Promise<OrdinaryRoomDeviceState> {
    const captured = { ...options }
    if (!/^[0-9a-f]{64}$/.test(captured.account) || !/^[0-9a-f]{64}$/.test(captured.roomId)) hold()
    const live = () => {
      const current = captured.current()
      return captured.live() && current?.account === captured.account && current.roomId === captured.roomId
    }
    const scope = await captured.owner.capture('room:' + captured.roomId, live)
    if (!live()) hold()
    const state = new OrdinaryRoomDeviceState(captured, scope)
    await state.#read(() => {})
    return state
  }
  /** Convert one legacy room only after complete cross-store cleanup. The
   * credential's verified account/device binding is the ownership evidence;
   * a device key alone never authorises guessing an account. All renames and
   * the immutable binding share one acknowledged encrypted candidate. */
  static async migrateLegacyRoom(options: Options): Promise<void> {
    const captured = { ...options }
    if (!/^[0-9a-f]{64}$/.test(captured.account) || !/^[0-9a-f]{64}$/.test(captured.roomId)) hold()
    const live = () => {
      const current = captured.current()
      return captured.live() && current?.account === captured.account && current.roomId === captured.roomId
    }
    const scope = await captured.owner.capture('room:' + captured.roomId, live)
    const state = new OrdinaryRoomDeviceState(captured, scope)
    await state.#track(captured.owner.mutateMigrated(scope, state.#live, (store, migratedNames) => {
      const legacy = new Map([...state.#names.keys()].flatMap(name => {
        const value = store.get(name); return value === null ? [] : [[name, value] as const]
      }))
      const declared = new Set(migratedNames)
      if (!legacy.size) {
        if ([...state.#names.keys()].some(name => declared.has(name)) && store.get(state.#binding) === null) hold()
        state.#view(store); return
      }
      for (const name of state.#names.keys()) if (legacy.has(name) !== declared.has(name)) hold()
      if (store.get(state.#binding) !== null || [...state.#names.values()].some(name => store.get(name) !== null)) hold()
      for (const [name, value] of legacy) state.#validate(name, value)
      if (!legacy.has(DEVICE_PREFIX + captured.roomId)) hold()
      let evidence = false
      for (const prefix of [CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX]) {
        const raw = legacy.get(prefix + captured.roomId)
        if (raw === undefined) continue
        const saved = state.#boundCredential(store, credential(JSON.parse(raw), captured.roomId))
        evidence = true
        const named = prefix === OWN_CREDENTIAL_PREFIX ? credentialSeal(saved) : undefined
        if (named) {
          const keys = loadOwnSealKeysFor(store, captured.roomId)
          try { if (!keys.some(key => getPublicKey(key) === named)) hold() }
          finally { for (const key of keys) key.fill(0) }
        }
      }
      if (!evidence) hold()
      for (const [name, value] of legacy) { store.set(state.#names.get(name)!, value); store.remove(name) }
      store.set(state.#binding, JSON.stringify({ account: captured.account, roomId: captured.roomId }))
      state.#view(store)
    }))
  }
  #live = (): boolean => {
    const current = this.#options.current()
    return !this.#closed && this.#options.live() && current?.account === this.#options.account && current.roomId === this.#options.roomId
  }
  #track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work); void work.finally(() => this.#work.delete(work)).catch(() => {})
    return work
  }
  #validate(name: string, raw: string): void {
    let value: unknown
    try { value = JSON.parse(raw) } catch { hold() }
    if (name === DEVICE_PREFIX + this.#options.roomId) {
      if (!object(value, ['sk','at']) || !integer(value.at)) hold()
      secret(value.sk)
    } else if (name === OWN_SEAL_PREFIX + this.#options.roomId) {
      if (!Array.isArray(value) || value.length > MAX_OWN_SEAL_KEYS || new Set(value).size !== value.length) hold()
      for (const item of value) { if (typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item)) hold(); secret(item) }
    } else credential(value, this.#options.roomId)
  }
  #view(store: DeviceStore): DeviceStore {
    // Unbound legacy records require explicit reviewed migration, never a
    // guessed account assignment or a plaintext/old-name fallback.
    for (const logical of this.#names.keys()) if (store.get(logical) !== null) hold()
    const binding = store.get(this.#binding)
    const present = [...this.#names.values()].some(name => store.get(name) !== null)
    // V2 device lifecycle requires both actor invitation fences and a full
    // paired image; this single-owner prepared-device adapter cannot renew it.
    const prefix = 'kithmoot.account.' + this.#options.account + '.'
    for (const name of store.keys()) if (name.startsWith(prefix + 'kithmoot.invitation-proof.v2.')) {
      const proof = JSON.parse(store.get(name)!) as { binding: { roomId: string } }
      if (proof.binding.roomId === this.#options.roomId) hold()
    }
    if (binding === null && !present) {
      const raw = store.get(prefix + 'kithmoot.room.' + this.#options.roomId)
      if (raw !== null) {
        const metadata = JSON.parse(raw) as { link: string; keep?: boolean }, link = parseRoomLink(metadata.link)
        try { if (metadata.keep === false && link.invitation?.persistent) hold() }
        finally { link.secret?.fill(0); link.invitation?.bearer.fill(0); link.pairingCode?.fill(0) }
      }
    }
    if (binding === null) { if (present) hold() }
    else {
      let value: unknown; try { value = JSON.parse(binding) } catch { hold() }
      if (!object(value, ['account','roomId']) || value.account !== this.#options.account || value.roomId !== this.#options.roomId ||
          store.get(this.#names.get(DEVICE_PREFIX + this.#options.roomId)!) === null) hold()
    }
    // Validate before permissive helpers: a swallowed parsing/storage error
    // must never turn authenticated corruption into an empty state.
    for (const [logical, physical] of this.#names) {
      const value = store.get(physical)
      if (value !== null) this.#validate(logical, value)
    }
    const check = (name: string): string => { const physical = this.#names.get(name); if (!physical) hold(); return physical }
    const view: DeviceStore = {
      get: name => { const value = store.get(check(name)); if (value !== null) this.#validate(name, value); return value },
      set: (name,value) => {
        const physical = check(name); this.#validate(name,value)
        if (name === DEVICE_PREFIX + this.#options.roomId && binding === null) {
          store.set(this.#binding, JSON.stringify({ account: this.#options.account, roomId: this.#options.roomId }))
        }
        store.set(physical,value)
      },
      remove: name => { store.remove(check(name)) },
      keys: () => [...this.#names].filter(([,physical]) => store.get(physical) !== null).map(([logical]) => logical),
    }
    for (const prefix of [CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX]) {
      const raw = view.get(prefix + this.#options.roomId)
      if (raw === null) continue
      const saved = credential(JSON.parse(raw), this.#options.roomId)
      this.#boundCredential(view, saved)
      const named = prefix === OWN_CREDENTIAL_PREFIX ? credentialSeal(saved) : undefined
      if (named) {
        const keys = loadOwnSealKeysFor(view, this.#options.roomId)
        try { if (!keys.some(key => getPublicKey(key) === named)) hold() }
        finally { for (const key of keys) key.fill(0) }
      }
    }
    return view
  }
  #read<T>(work: (store: DeviceStore) => T): Promise<T> {
    return this.#track(this.#options.owner.read(this.#scope, this.#live, store => work(this.#view(store))))
  }
  #mutate<T>(work: (store: DeviceStore) => T): Promise<T> {
    return this.#track(this.#options.owner.mutate(this.#scope, this.#live, store => {
      const result = work(this.#view(store))
      this.#view(store) // Verify the completed multi-record helper result before encryption.
      return result
    }))
  }
  #secretResult<T extends Uint8Array | Uint8Array[] | undefined>(mutating: boolean, work: (store: DeviceStore) => T): Promise<T> {
    let captured: T | undefined
    const operation = (store: DeviceStore): T => { captured = work(store); return captured }
    return this.#track((mutating ? this.#mutate(operation) : this.#read(operation)).catch(error => {
      wipe(captured)
      throw error
    }))
  }
  /** Pruning is confined to the captured room; it cannot delete another
   * room's key as a side effect of opening this one. */
  deviceKey(now: number): Promise<Uint8Array> {
    if (!integer(now)) hold()
    return this.#secretResult(true, store => {
      if (!store.get(DEVICE_PREFIX + this.#options.roomId) &&
          [...this.#names.keys()].some(name => name !== DEVICE_PREFIX + this.#options.roomId && store.get(name) !== null)) hold()
      return deviceKeyFor(store, this.#options.roomId, now, generateSecretKey)
    })
  }
  loadDeviceKey(): Promise<Uint8Array | undefined> { return this.#secretResult(false, store => loadDeviceKeyFor(store, this.#options.roomId)) }
  sealKeys(): Promise<Uint8Array[]> { return this.#secretResult(false, store => loadOwnSealKeysFor(store, this.#options.roomId)) }
  ownCredential(now: number): Promise<DeviceCredential | undefined> {
    if (!integer(now)) hold()
    return this.#mutate(store => {
      const raw = store.get(OWN_CREDENTIAL_PREFIX + this.#options.roomId)
      if (raw) {
        const saved = credential(JSON.parse(raw), this.#options.roomId)
        if (saved.pubkey.toLowerCase() !== this.#options.account) hold()
        this.#boundCredential(store, saved)
      }
      return loadOwnCredentialFor(store, this.#options.roomId, now)
    })
  }
  secondaryCredential(): Promise<DeviceCredential | undefined> {
    return this.#read(store => {
      const saved = loadCredentialFor(store, this.#options.roomId)
      return saved ? this.#boundCredential(store, saved) : undefined
    })
  }
  #boundCredential(store: DeviceStore, input: DeviceCredential): DeviceCredential {
    const saved = credential(input, this.#options.roomId)
    const key = loadDeviceKeyFor(store, this.#options.roomId)
    const device = saved.tags.find(tag => tag[0] === 'device')?.[1]
    try {
      if (!key || saved.pubkey.toLowerCase() !== this.#options.account || device?.toLowerCase() !== getPublicKey(key)) hold()
      return saved
    } finally { key?.fill(0) }
  }
  retainSecondaryCredential(input: DeviceCredential): Promise<void> {
    const saved = structuredClone(input)
    return this.#mutate(store => storeCredentialFor(store, this.#options.roomId, this.#boundCredential(store, saved)))
  }
  /** Credential and the complete seal history share one encrypted candidate.
   * Suitable for RoomSession.retainCredential after owner bootstrap/migration. */
  retainOwnCredential(input: DeviceCredential, sealSk?: Uint8Array): Promise<void> {
    const saved = structuredClone(input), seal = sealSk?.slice()
    return this.#mutate(store => {
      const bound = this.#boundCredential(store, saved), namedSeal = credentialSeal(bound)
      if (seal && (seal.length !== 32 || !namedSeal || getPublicKey(seal) !== namedSeal.toLowerCase())) hold()
      if (namedSeal && !seal) hold()
      storeOwnCredentialFor(store, this.#options.roomId, bound, seal)
    }).finally(() => seal?.fill(0))
  }
  /** Revoke this adapter without closing the browser owner shared by rooms. */
  async close(): Promise<void> { this.#closed = true; await Promise.allSettled([...this.#work]) }
}
