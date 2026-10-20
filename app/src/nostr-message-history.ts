import type { Event } from 'nostr-tools/pure'
import type { DeviceStore } from './device-store.js'
import { captureOrdinaryCopy, ordinaryExpired, ORDINARY_MAX_COPIES, ORDINARY_MAX_HISTORY_BYTES } from './nostr-message-wire.js'

export type OrdinaryHistoryLock = (key: string) => Promise<() => void>
export const ordinaryHistoryKey = (account: string): string => `kithmoot.ordinary-message-copies.v1.${account}`

/** Original gift wraps only: no plaintext, decoded sender, conversation index,
 * new key or native authority. The caller holds this account's writer lock.
 * A changed/unrecognised saved record is refused, never silently replaced. */
export class OrdinaryMessageHistory {
  readonly key: string
  #head: string | null
  #events: Event[]
  constructor(private readonly store: DeviceStore, readonly account: string, private readonly now: () => number) {
    if (!/^[0-9a-f]{64}$/.test(account)) throw Error('Invalid ordinary history account.')
    this.key = ordinaryHistoryKey(account)
    this.#head = store.get(this.key)
    this.#events = []
    if (this.#head !== null) {
      if (this.#head.length > ORDINARY_MAX_HISTORY_BYTES || new TextEncoder().encode(this.#head).byteLength > ORDINARY_MAX_HISTORY_BYTES) throw Error('Saved message copies exceed their limit.')
      const saved = JSON.parse(this.#head)
      if (!saved || Object.keys(saved).sort().join(',') !== 'account,events,v' || saved.v !== 1 || saved.account !== account ||
          !Array.isArray(saved.events) || saved.events.length > ORDINARY_MAX_COPIES) throw Error('Saved message copies have an unknown format.')
      const ids = new Set<string>()
      for (const input of saved.events) {
        const event = captureOrdinaryCopy(input, account, now(), true)
        if (!event || ids.has(event.id)) throw Error('Saved message copies failed verification.')
        ids.add(event.id)
        if (!ordinaryExpired(event, now())) this.#events.push(event)
      }
    }
  }
  copies(): readonly Event[] { return this.#events.filter(event => !ordinaryExpired(event, this.now())) }
  append(input: Event, current: () => boolean): { retained: readonly Event[]; limited: boolean } {
    const event = captureOrdinaryCopy(input, this.account, this.now())
    if (!event || !current()) throw Error('Message history is no longer current.')
    const next = [...this.copies().filter(row => row.id !== event.id), event]
    let limited = false
    const encode = () => JSON.stringify({ v: 1, account: this.account, events: next })
    let raw = encode()
    while (next.length > ORDINARY_MAX_COPIES || new TextEncoder().encode(raw).byteLength > ORDINARY_MAX_HISTORY_BYTES) {
      if (next.length <= 1) throw Error('Message copy exceeds the saved-history limit.')
      next.shift(); limited = true; raw = encode()
    }
    if (this.store.get(this.key) !== this.#head || !current()) throw Error('Message history changed in another view.')
    this.store.set(this.key, raw)
    this.#head = raw; this.#events = next
    return { retained: this.copies(), limited }
  }
}

/** Compose retains its exact encrypted self-copy before publishing either
 * envelope. A failed/busy history write holds sending; it cannot invent ACKs. */
export async function rememberOrdinaryCopy(store: DeviceStore, account: string, copy: Event,
  acquire: OrdinaryHistoryLock, current: () => boolean): Promise<void> {
  if (!current()) throw Error('Account view changed.')
  const release = await acquire(ordinaryHistoryKey(account))
  try {
    if (!current()) throw Error('Account view changed.')
    new OrdinaryMessageHistory(store, account, () => Math.floor(Date.now() / 1000)).append(copy, current)
  } finally { release() }
}
