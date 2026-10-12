import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, type OrdinaryScope } from './ordinary-state-owner.js'

const PARTICIPANT = 'kithmoot.participant'
const SECONDARY = /^(?:kithmoot\.account\.[0-9a-f]{64}\.)?kithmoot\.credential\.[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function decode(value: string | null): Uint8Array | undefined {
  if (value === null) return undefined
  if (!/^[0-9a-f]{64}$/.test(value)) hold()
  const key = hexToBytes(value)
  try { getPublicKey(key); return key }
  catch (error) { key.fill(0); throw error instanceof OrdinaryStateHold ? error : new OrdinaryStateHold() }
}

interface Options {
  owner: OrdinaryStateOwner
  /** Captured foreground identity generation; sign-in/sign-out advances it. */
  generation: number
  currentGeneration(): number
  live(): boolean
  /** Only the visitor identity flow can authorise first creation. */
  allowCreate(): boolean
}

/** Private browser-participant custody. No synchronous plaintext fallback or
 * arbitrary writer is exposed. Bootstrap must prepare and migrate the complete
 * browser owner before opening this adapter or invoking any signer. */
export class OrdinaryParticipantState {
  readonly #options: Options
  readonly #scope: OrdinaryScope
  readonly #work = new Set<Promise<unknown>>()
  #closed = false
  private constructor(options: Options, scope: OrdinaryScope) { this.#options = options; this.#scope = scope }
  #live = (): boolean => !this.#closed && this.#options.live() && this.#options.currentGeneration() === this.#options.generation
  #track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work); void work.finally(() => this.#work.delete(work)).catch(() => {})
    return work
  }
  static async open(options: Options): Promise<OrdinaryParticipantState> {
    const captured = { ...options }
    if (!Number.isSafeInteger(captured.generation) || captured.generation < 0) hold()
    const live = () => captured.live() && captured.currentGeneration() === captured.generation
    const scope = await captured.owner.capture('@ordinary-participant', live)
    if (!live()) hold()
    const state = new OrdinaryParticipantState(captured, scope)
    const existing = await state.load(); existing?.fill(0)
    return state
  }
  load(): Promise<Uint8Array | undefined> {
    let captured: Uint8Array | undefined
    return this.#track(this.#options.owner.read(this.#scope, this.#live, store => {
      captured = decode(store.get(PARTICIPANT)); return captured
    }).catch(error => { captured?.fill(0); throw error }))
  }
  /** Resolve only after the key belongs to the acknowledged native image.
   * An uncertain write holds one exact candidate and blocks replacement keys. */
  key(): Promise<Uint8Array> {
    let captured: Uint8Array | undefined, creating = false
    const live = () => this.#live() && (!creating || this.#options.allowCreate())
    return this.#track(this.#options.owner.mutate(this.#scope, live, store => {
      captured = decode(store.get(PARTICIPANT))
      if (!captured) {
        if (!this.#options.allowCreate() || store.keys().some(name => SECONDARY.test(name) || name === 'kithmoot.credential')) hold()
        creating = true
        captured = generateSecretKey()
        store.set(PARTICIPANT, bytesToHex(captured))
      }
      return captured
    }).catch(error => { captured?.fill(0); throw error }))
  }
  /** Revoke synchronously and join native receipts and secret cleanup. */
  async close(): Promise<void> { this.#closed = true; await Promise.allSettled([...this.#work]) }
}
