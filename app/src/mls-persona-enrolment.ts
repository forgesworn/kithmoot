import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { loadMlsEngine } from './mls-engine.js'
import { BrowserMlsPersonaStore, PersonaStorageError, type LockedPersonaStore, type PersonaSnapshot } from './mls-persona-store.js'
import { BrowserPersonaLinks } from './mls-persona-link.js'
import { pairedWitnessIdentity, personaWriter } from './mls-writer-identity.js'

export type PersonaEnrolment = { state: 'empty' | 'stale' } | { state: 'fenced'; reason: string } |
  { state: 'prepared'; installation: string; writer: string } |
  { state: 'paired'; installation: string; writer: string; witness: string } |
  { state: 'genesis'; installation: string; writer: string; witness: string; subject: string; digest: string; command: string }

/** Explicit local ceremony. The keeper, not the browser, runs enrol on the
 * chosen Bothy. Displayed genesis means durably prepared, never witness
 * acceptance. BrowserPersonaCoordinator must still fresh-read before use. */
export class BrowserPersonaEnrolment {
  constructor(private readonly store: BrowserMlsPersonaStore, private readonly links: BrowserPersonaLinks,
    private readonly engine = loadMlsEngine) {}

  status(persona: string, current: () => boolean): Promise<PersonaEnrolment> {
    return this.#operation(persona, current, async (store, file) => this.#view(store, file))
  }
  prepare(persona: string, current: () => boolean): Promise<PersonaEnrolment> {
    return this.#operation(persona, current, async (store, file) => this.#view(store, file ?? await store.create()))
  }
  pair(persona: string, uri: string, relays: readonly string[], current: () => boolean): Promise<PersonaEnrolment> {
    return this.#operation(persona, current, async (store, file) => {
      if (!file || !this.#mayEnrol(file)) return this.#view(store, file)
      const seed = hexToBytes(file.data.writerSeed)
      let route
      try { route = await this.links.pair(seed, uri, relays, current) } finally { seed.fill(0) }
      if (!current()) return { state: 'stale' }
      if (!route) return this.#view(store, file)
      pairedWitnessIdentity(route)
      const saved = await store.write(file.revision, { ...file.data, witnessRoute: route }, file.marker)
      return this.#view(store, saved)
    })
  }
  genesis(persona: string, current: () => boolean): Promise<PersonaEnrolment> {
    return this.#operation(persona, current, async (store, file) => {
      if (!file || !this.#mayEnrol(file) || !file.data.witnessRoute) return this.#view(store, file)
      if (file.data.active.vault.length || file.data.active.sessions.length || file.data.staged) throw new PersonaStorageError('invalid')
      const wasm = await this.engine()
      if (!current()) return { state: 'stale' }
      const subject = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
      if (file.marker.retired.some(t => t.subject === subject || t.installation === file.data.installation)) throw new PersonaStorageError('conflict')
      const witness = pairedWitnessIdentity(file.data.witnessRoute), writer = personaWriter(file.data.writerSeed)
      const genesis = wasm.coordinatorGenesis(hexToBytes(subject), hexToBytes(file.data.installation), hexToBytes(witness), [])
      const digest = bytesToHex(genesis.digest), enrolment = { subject, witness, writer, digest }
      const saved = await store.write(file.revision, { ...file.data, enrolment, coordinator: bytesToHex(genesis.state) },
        { ...file.marker, state: 'genesis', subject, writer, digest })
      // The container and marker commit atomically. An interrupted return is
      // retried by reading this exact genesis, never minting another subject.
      return this.#view(store, saved)
    })
  }
  #mayEnrol(file: PersonaSnapshot): boolean { return file.marker.state === 'prepared' && file.data.coordinator === null && !file.data.cleared }
  async #view(store: LockedPersonaStore, file: PersonaSnapshot | undefined): Promise<PersonaEnrolment> {
    const marker = file?.marker ?? await store.marker()
    if (marker?.state === 'fenced') return { state: 'fenced', reason: marker.reason! }
    if (!file) return { state: 'empty' }
    const installation = file.data.installation, writer = personaWriter(file.data.writerSeed), enrolled = file.data.enrolment
    if (enrolled) {
      // read/write validated these sealed fields against the marker, seed and
      // signed paired card. No keeper command is composed from a marker alone.
      return { state: 'genesis', installation, ...enrolled,
        command: `bothyd witness enrol --subject ${enrolled.subject} --installation ${installation} --writer ${writer} --initial-digest ${enrolled.digest}` }
    }
    if (!this.#mayEnrol(file)) throw new PersonaStorageError('invalid')
    return file.data.witnessRoute ? { state: 'paired', installation, writer, witness: pairedWitnessIdentity(file.data.witnessRoute) } : { state: 'prepared', installation, writer }
  }
  async #operation(persona: string, current: () => boolean,
    work: (store: LockedPersonaStore, file: PersonaSnapshot | undefined) => Promise<PersonaEnrolment>): Promise<PersonaEnrolment> {
    if (!current()) return { state: 'stale' }
    const result = await this.store.withPersona(persona, async store => {
      if (!current()) return { state: 'stale' } as const
      let file: PersonaSnapshot | undefined
      try { file = await store.read(true) } catch (error) {
        if (!(error instanceof PersonaStorageError) || !['invalid', 'seal-lost', 'missing-record'].includes(error.code)) throw error
        return { state: 'fenced', reason: (await store.fence(error.code)).reason! } as const
      }
      if (!current()) return { state: 'stale' } as const
      // An absent inner key is not a fresh empty genesis. A cleared duty can
      // still be read by the coordinator, but never paired or enrolled here.
      if (file && !file.data.cleared && !await store.hasInnerKey()) return { state: 'fenced', reason: (await store.fence('seal-lost')).reason! } as const
      if (!current()) return { state: 'stale' } as const
      if (file?.marker.state === 'fenced') return this.#view(store, file)
      return work(store, file)
    })
    return current() ? result : { state: 'stale' }
  }
}
