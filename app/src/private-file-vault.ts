import { BrowserRendezvousVaultStorage, type RendezvousVaultStorage } from './rendezvous-vault.js'

export interface PrivateFileScope { account: string; room: string; node: string; routeId: string }
export interface PrivateFilePermission extends PrivateFileScope { id: string; until: number }
export interface PrivateFileTicket extends PrivateFilePermission { revision: string }
/** Upload intent is durable before the request. Neither file keys nor names
 * belong here. An uncertain or retained blob must survive room withdrawal. */
export interface PrivateFileUpload extends PrivateFileScope {
  id: string; hash: string; size: number; created: number
  status: 'uncertain' | 'stored' | 'kept'
}
interface State { version: 1; revision: string; permissions: PrivateFilePermission[]; uploads: PrivateFileUpload[] }
const aad = new TextEncoder().encode('kithmoot.private-file-journal.v1')
const MAX_BYTES = 512 * 1024
const MAX_CIPHERTEXT_BYTES = 64 * 1024 * 1024
const hex = /^[0-9a-f]{64}$/
const id = /^[0-9a-f-]{36}$/
const node = /^[a-z2-7]{51}[aq]$/
const integer = (n: number): boolean => Number.isSafeInteger(n) && n >= 0
export function sameFileScope(a: PrivateFileScope, b: PrivateFileScope): boolean {
  return a.account === b.account && a.room === b.room && a.node === b.node && a.routeId === b.routeId
}
function validateScope(s: PrivateFileScope): void {
  if (!s || !hex.test(s.account) || !hex.test(s.room) || !node.test(s.node) || !/^[A-Za-z0-9._:-]{1,128}$/.test(s.routeId)) throw new Error('Invalid private file destination.')
}
function validate(state: State): void {
  if (!state || state.version !== 1 || typeof state.revision !== 'string' || state.revision.length > 64 || !Array.isArray(state.permissions) || state.permissions.length > 100 || !Array.isArray(state.uploads) || state.uploads.length > 1000) throw new Error('Private file storage could not be verified.')
  const scopes = new Set<string>(), ids = new Set<string>()
  for (const p of state.permissions) {
    validateScope(p)
    const key = `${p.account}/${p.room}`
    if (!id.test(p.id) || !integer(p.until) || p.until === 0 || scopes.has(key)) throw new Error('Invalid private file permission.')
    scopes.add(key)
  }
  for (const u of state.uploads) {
    validateScope(u)
    if (!id.test(u.id) || ids.has(u.id) || !hex.test(u.hash) || !integer(u.size) || u.size < 1 || u.size > MAX_CIPHERTEXT_BYTES || !integer(u.created) || !['uncertain', 'stored', 'kept'].includes(u.status)) throw new Error('Invalid private file upload journal.')
    ids.add(u.id)
  }
}
function copy<T>(value: T): T { return structuredClone(value) }
function equal(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = new Uint8Array(a), y = new Uint8Array(b)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** Reuses the existing encrypted IndexedDB/CryptoKey adapter and its Web Lock.
 * The nonsecret revision invalidates consent synchronously across tabs. A
 * changed revision is written into the encrypted state on commit, so a new
 * operation also refuses while a permission change is pending or failed. */
export class PrivateFileVault {
  constructor(private storage: RendezvousVaultStorage = new BrowserRendezvousVaultStorage('kithmoot-private-file-journal-v1')) {
    if (!storage.withLock || !storage.revision || !storage.invalidate) throw new Error('Private files require coordinated encrypted storage.')
  }
  revision(): string { return this.storage.revision!() }
  async permission(scope: PrivateFileScope, now: number): Promise<PrivateFileTicket | undefined> {
    validateScope(scope)
    if (!integer(now)) throw new Error('Private files need a valid clock.')
    return this.storage.withLock!(async () => {
      const state = await this.#read()
      this.#ready(state)
      const permission = state.permissions.find(p => sameFileScope(p, scope) && p.until > now)
      return permission ? { ...copy(permission), revision: state.revision } : undefined
    })
  }
  async current(ticket: PrivateFileTicket, now: number): Promise<boolean> {
    const p = await this.permission(ticket, now)
    return !!p && p.id === ticket.id && p.until === ticket.until && p.revision === ticket.revision
  }
  allow(scope: PrivateFileScope, until: number, current: () => void = () => {}): Promise<void> {
    const owned = copy(scope); validateScope(owned)
    if (!integer(until) || until === 0) throw new Error('Invalid private file deadline.')
    return this.#policy(state => {
      state.permissions = state.permissions.filter(p => p.account !== owned.account || p.room !== owned.room)
      state.permissions.push({ ...owned, id: crypto.randomUUID(), until })
    }, current)
  }
  revoke(account: string, room: string): Promise<void> {
    if (!hex.test(account) || !hex.test(room)) throw new Error('Invalid private file permission.')
    return this.#policy(state => { state.permissions = state.permissions.filter(p => p.account !== account || p.room !== room) })
  }
  async intent(ticket: PrivateFileTicket, hash: string, size: number, now: number): Promise<PrivateFileUpload> {
    const owned = copy(ticket)
    const upload: PrivateFileUpload = { account: owned.account, room: owned.room, node: owned.node, routeId: owned.routeId,
      id: crypto.randomUUID(), hash, size, created: now, status: 'uncertain' }
    return this.storage.withLock!(async () => {
      const state = await this.#read(); this.#ready(state)
      const p = state.permissions.find(p => sameFileScope(p, owned) && p.id === owned.id && p.until === owned.until)
      if (!p || p.until <= now || state.revision !== owned.revision) throw new Error('Private file permission changed. Nothing was uploaded.')
      state.uploads.push(upload); await this.#write(state)
      return copy(upload)
    })
  }
  async uploads(account: string, room: string): Promise<PrivateFileUpload[]> {
    if (!hex.test(account) || !hex.test(room)) throw new Error('Invalid private file journal scope.')
    return this.storage.withLock!(async () => copy((await this.#read()).uploads.filter(u => u.account === account && u.room === room)))
  }
  async accountUploads(account: string): Promise<PrivateFileUpload[]> {
    if (!hex.test(account)) throw new Error('Invalid private file journal account.')
    return this.storage.withLock!(async () => copy((await this.#read()).uploads.filter(u => u.account === account)))
  }
  async outcome(upload: PrivateFileUpload, status: 'stored' | 'kept' | 'deleted'): Promise<void> {
    const owned = copy(upload)
    await this.storage.withLock!(async () => {
      const state = await this.#read()
      const saved = state.uploads.find(u => u.id === owned.id)
      if (!saved || !sameFileScope(saved, owned) || saved.hash !== owned.hash || saved.size !== owned.size || saved.created !== owned.created) throw new Error('Private file upload provenance changed; its journal was retained.')
      if (status === 'deleted') state.uploads = state.uploads.filter(u => u.id !== owned.id)
      else saved.status = status
      // Receipt adoption is allowed after consent withdrawal: this records
      // what the old operation did, never stages a file in the current room.
      await this.#write(state)
    })
  }
  /** Forget cannot discard uncertain/retained upload provenance. Keep the
   * custody lock across the browser's wipe, then erase this vault's key and
   * records. Queued policy writes retain an obsolete revision and stay held. */
  async forget(work: () => Promise<void>): Promise<boolean> {
    if (!this.storage.erase) throw new Error('Private file storage cannot be safely erased in this browser.')
    this.storage.invalidate!()
    return this.storage.withLock!(async () => {
      const state = await this.#read()
      if (state.uploads.length) return false
      await work()
      await this.storage.erase!()
      return true
    })
  }
  #policy(change: (state: State) => void, current: () => void = () => {}): Promise<void> {
    this.storage.invalidate!()
    const revision = this.revision()
    const guarded = (): void => {
      current()
      if (revision !== this.revision()) throw new Error('Private file permission changed before its save completed.')
    }
    return this.storage.withLock!(async () => {
      try {
        guarded()
        const state = await this.#read(); guarded(); change(state); state.revision = revision
        await this.#write(state, guarded); guarded(); this.#ready(state)
      } catch (error) {
        // A delayed disk commit can land after its context vanished. No
        // reader can enter this lock until its newly saved grant is held.
        if (revision === this.revision()) this.storage.invalidate!()
        throw error
      }
    })
  }
  #ready(state: State): void {
    if (state.revision !== this.revision()) throw new Error('Private file permission is changing or could not be saved. Review it again before continuing.')
  }
  async #read(): Promise<State> {
    const record = await this.storage.record()
    if (!record) return { version: 1, revision: '', permissions: [], uploads: [] }
    const key = await this.storage.key()
    if (!key || record.version !== 1 || record.nonce.byteLength !== 12 || record.ciphertext.byteLength > MAX_BYTES + 16) throw new Error('Private file storage could not be opened; its journal was retained.')
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce, additionalData: aad }, key, record.ciphertext))
    try {
      const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as State
      validate(state); return state
    } finally { bytes.fill(0) }
  }
  async #write(state: State, current: () => void = () => {}): Promise<void> {
    validate(state)
    const bytes = new TextEncoder().encode(JSON.stringify(state))
    try {
      if (bytes.length > MAX_BYTES) throw new Error('Private file journal is full; nothing was discarded.')
      let key = await this.storage.key()
      if (!key) {
        if (await this.storage.record()) throw new Error('Private file storage key is unavailable; its journal was retained.')
        key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        await this.storage.saveKey(key)
      }
      const nonce = crypto.getRandomValues(new Uint8Array(12)).buffer
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, bytes)
      current()
      await this.storage.put({ key: 'active', version: 1, nonce, ciphertext })
      current()
      const saved = await this.storage.record()
      if (!saved || !equal(saved.nonce, nonce) || !equal(saved.ciphertext, ciphertext)) throw new Error('Private file journal could not be saved and verified.')
    } finally { bytes.fill(0) }
  }
}
