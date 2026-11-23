import type { SignetStorage } from 'signet-login'
import { sanitiseDisplayName } from '../../src/display-name.js'
import { ORDINARY_SIGNET_KEYS as keys, validateOrdinarySignetSnapshot } from './ordinary-signet-snapshot.js'
import { BrowserRendezvousVaultStorage, type RendezvousVaultStorage } from './rendezvous-vault.js'

const SESSION_KEYS: readonly string[] = [keys.pubkey, keys.method, keys.authEvent, keys.bunkerUri, keys.bunkerClientSk, keys.expiresAt, keys.displayName]
const AAD = new TextEncoder().encode('kithmoot.signer-personas.v1')
const MAX_BYTES = 2 * 1024 * 1024

export interface Persona {
  pubkey: string
  label: string
  method: 'bunker' | 'nip07'
}

export interface PersonaConnection extends Persona {
  session: Readonly<Record<string, string>>
}

export interface PersonaSelection {
  active: string | null
  personas: Persona[]
}

interface SavedPersonas {
  active: string | null
  connections: PersonaConnection[]
}

/** Pair and restore one signer in private working memory. The SDK may clear
 * its input after a refusal, so it never works directly on a saved persona. */
export class PersonaSessionStorage implements SignetStorage {
  #values: Map<string, string>
  constructor(session: Readonly<Record<string, string>> = {}) { this.#values = new Map(Object.entries(session)) }
  getItem(key: string): string | null { return this.#values.get(key) ?? null }
  setItem(key: string, value: string): void { this.#values.set(key, value) }
  removeItem(key: string): void { this.#values.delete(key) }
}

export function personaConnection(storage: Pick<Storage, 'getItem'>, pubkey: string, label: string, origin: string): PersonaConnection | undefined {
  const session: Record<string, string> = {}
  for (const key of SESSION_KEYS) {
    const value = storage.getItem(key)
    if (value !== null) session[key] = value
  }
  const method = session[keys.method]
  if (session[keys.pubkey] !== pubkey || (method !== 'nip07' && method !== 'bunker')) return undefined
  validateOrdinarySignetSnapshot(new Map(Object.entries(session)), { kind: 'browser', origin, appName: 'KithMoot', account: pubkey })
  return { pubkey, method, label: sanitiseDisplayName(label || session[keys.displayName] || '') ?? '', session }
}

export function forgetLegacyPersonaConnection(storage: Pick<Storage, 'removeItem'>): void {
  for (const key of Object.values(keys)) storage.removeItem(key)
}

/** The whole selection commits with its connections. A single non-extractable
 * device key protects the credentials and local names. The storage lock
 * serialises changes from multiple tabs, including key creation and erasure. */
export class PersonaStore {
  constructor(private readonly origin: string, private readonly storage: RendezvousVaultStorage =
    new BrowserRendezvousVaultStorage('kithmoot-signer-personas-v1')) {}

  async selection(): Promise<PersonaSelection | undefined> {
    return this.#locked(async () => {
      const saved = await this.#read()
      return saved && this.#summary(saved)
    })
  }

  async connection(pubkey: string): Promise<PersonaConnection | undefined> {
    return this.#locked(async () => (await this.#read())?.connections.find(persona => persona.pubkey === pubkey))
  }

  async add(selected: PersonaConnection, previous?: PersonaConnection): Promise<PersonaSelection> {
    return this.#locked(async () => {
      const saved = (await this.#read()) ?? { active: null, connections: [] }
      const connections = saved.connections.filter(persona => persona.pubkey !== selected.pubkey)
      if (previous && previous.pubkey !== selected.pubkey && !connections.some(persona => persona.pubkey === previous.pubkey)) {
        connections.push(previous)
      }
      const earlier = saved.connections.find(persona => persona.pubkey === selected.pubkey)
      return this.#write({ active: selected.pubkey, connections: [{ ...selected, label: selected.label || earlier?.label || '' }, ...connections] })
    })
  }

  async select(expected: PersonaConnection, restored: PersonaConnection): Promise<PersonaSelection> {
    return this.#locked(async () => {
      const saved = await this.#read()
      const current = saved?.connections.find(persona => persona.pubkey === expected.pubkey)
      if (!saved || !current || restored.pubkey !== expected.pubkey ||
          SESSION_KEYS.some(key => current.session[key] !== expected.session[key])) {
        throw new Error('This signer connection changed. Open Personas and choose it again.')
      }
      return this.#write({ active: restored.pubkey, connections: [
        { ...restored, label: current.label }, ...saved.connections.filter(persona => persona !== current),
      ] })
    })
  }

  async disconnect(pubkey?: string): Promise<PersonaSelection> {
    return this.#locked(async () => {
      const saved = (await this.#read()) ?? { active: null, connections: [] }
      return this.#write({
        active: pubkey && saved.active !== pubkey ? saved.active : null,
        connections: saved.connections.filter(persona => persona.pubkey !== pubkey),
      })
    })
  }

  async erase(): Promise<void> { await this.#locked(() => this.storage.erase!()) }

  #locked<T>(work: () => Promise<T>): Promise<T> {
    if (!this.storage.withLock) throw new Error('This browser cannot keep multiple signer connections securely.')
    return this.storage.withLock(work)
  }

  #summary(saved: SavedPersonas): PersonaSelection {
    return { active: saved.active, personas: saved.connections.map(({ pubkey, label, method }) => ({ pubkey, label, method })) }
  }

  #validate(saved: SavedPersonas): void {
    if (!saved || !Array.isArray(saved.connections)) throw new Error('The saved persona list is unreadable.')
    const found = new Set<string>()
    for (const persona of saved.connections) {
      if (!persona || found.has(persona.pubkey) || typeof persona.label !== 'string' ||
          (sanitiseDisplayName(persona.label) ?? '') !== persona.label || !persona.session ||
          Object.keys(persona.session).some(key => !SESSION_KEYS.includes(key)) ||
          persona.method !== persona.session[keys.method] ||
          !personaConnection(new PersonaSessionStorage(persona.session), persona.pubkey, persona.label, this.origin)) {
        throw new Error('A saved signer connection is unreadable.')
      }
      found.add(persona.pubkey)
    }
    if (saved.active !== null && !found.has(saved.active)) throw new Error('The selected persona is missing.')
  }

  async #read(): Promise<SavedPersonas | undefined> {
    const record = await this.storage.record()
    if (!record) return undefined
    const key = await this.storage.key()
    if (!key || record.version !== 1 || record.nonce.byteLength !== 12 || record.ciphertext.byteLength > MAX_BYTES) {
      throw new Error('The saved persona list is unreadable.')
    }
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce, additionalData: AAD }, key, record.ciphertext))
    try {
      const saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as SavedPersonas
      this.#validate(saved)
      return saved
    } finally { bytes.fill(0) }
  }

  async #write(saved: SavedPersonas): Promise<PersonaSelection> {
    this.#validate(saved)
    const bytes = new TextEncoder().encode(JSON.stringify(saved))
    try {
      if (bytes.byteLength + 16 > MAX_BYTES) throw new Error('There is not enough space for another saved connection.')
      let key = await this.storage.key()
      if (!key) {
        key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        await this.storage.saveKey(key)
      }
      const nonce = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, key, bytes)
      await this.storage.put({ key: 'active', version: 1, nonce: nonce.buffer, ciphertext })
      return this.#summary(saved)
    } finally { bytes.fill(0) }
  }
}
