import type { Event } from 'nostr-tools/pure'
import type { DeviceStore } from './device-store.js'
import { captureOrdinaryCopy, ordinaryExpired, ORDINARY_MAX_COPIES, ORDINARY_MAX_HISTORY_BYTES, type OrdinaryText } from './nostr-message-wire.js'

export type OrdinaryHistoryLock = (key: string) => Promise<() => void>
export const ordinaryHistoryKey = (account: string): string => `kithmoot.ordinary-message-copies.v1.${account}`
export const ordinarySendStatusKey = (account: string): string => `kithmoot.ordinary-message-send-status.v1.${account}`
const sendStatuses = ['unconfirmed', 'copy-unconfirmed', 'sent'] as const
export type OrdinarySendStatus = typeof sendStatuses[number]
export interface OrdinaryOutgoingMessage {
  message: OrdinaryText
  copy: Event
  status: OrdinarySendStatus
}

export function mergeSendStatus(previous: OrdinarySendStatus | undefined, update: OrdinarySendStatus): OrdinarySendStatus {
  return previous && sendStatuses.indexOf(previous) > sendStatuses.indexOf(update) ? previous : update
}

/** Local relay acknowledgements keyed by the encrypted sender-copy ID. The
 * ciphertext history format stays readable by older clients. */
export function readOrdinarySendStatuses(store: DeviceStore, account: string): Map<string, OrdinarySendStatus> {
  const statuses = new Map<string, OrdinarySendStatus>()
  try {
    const raw = store.get(ordinarySendStatusKey(account))
    if (!raw || raw.length > ORDINARY_MAX_COPIES * 100) return statuses
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows) || rows.length > ORDINARY_MAX_COPIES) return statuses
    for (const row of rows) {
      if (Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && /^[0-9a-f]{64}$/.test(row[0]) && sendStatuses.includes(row[1])) {
        statuses.set(row[0], mergeSendStatus(statuses.get(row[0]), row[1]))
      }
    }
  } catch { /* Encrypted history is still usable without local send statuses. */ }
  return statuses
}

export async function rememberOrdinarySendStatus(store: DeviceStore, account: string, copyId: string, status: OrdinarySendStatus,
  acquire: OrdinaryHistoryLock, current: () => boolean): Promise<void> {
  if (!current()) return
  const key = ordinarySendStatusKey(account)
  const release = await acquire(key)
  try {
    if (!current()) return
    const saved = readOrdinarySendStatuses(store, account)
    const next = mergeSendStatus(saved.get(copyId), status)
    saved.delete(copyId)
    saved.set(copyId, next)
    store.set(key, JSON.stringify([...saved].slice(-ORDINARY_MAX_COPIES)))
  } finally { release() }
}

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
    return this.merge([input], current)
  }
  merge(inputs: readonly Event[], current: () => boolean): { retained: readonly Event[]; limited: boolean } {
    if (!current()) throw Error('Message history is no longer current.')
    const copies = new Map(this.copies().map(copy => [copy.id, copy]))
    for (const input of inputs) {
      const event = captureOrdinaryCopy(input, this.account, this.now())
      if (!event) throw Error('Message history received an invalid copy.')
      copies.delete(event.id)
      copies.set(event.id, event)
    }
    const next = [...copies.values()]
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
