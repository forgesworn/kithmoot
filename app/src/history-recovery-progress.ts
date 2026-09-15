/** Durable, device-local progress for explicitly selected history windows.
 *
 * A recovery cursor is never a claim that a relay contains all history. It
 * only records that this browser received EOSE for one bounded request, so a
 * later deliberate action can ask for the adjacent older window. */
import type { HistoryImportReceipt, HistoryRequestClass } from '../../src/history-import.js'
import type { DeviceStore } from './device-store.js'

const PREFIX = 'kithmoot.history-recovery.v1.'
const HEX = /^[0-9a-f]{64}$/

export interface HistoryRecoveryProgress {
  version: 1
  person: string
  node: string
  windows: HistoryRecoveryWindow[]
}

export interface HistoryRecoveryWindow {
  relay: string
  class: HistoryRequestClass
  /** Inclusive end of the next requested window, in Unix seconds. */
  until: number
}

function key(person: string, node: string): string {
  if (!HEX.test(person) || !HEX.test(node)) throw new Error('History recovery needs canonical account and box keys.')
  return PREFIX + person + '.' + node
}

/** Reads only valid state bound to this exact signed account and verified box.
 * A malformed entry is forgotten rather than turned into an unexpected relay
 * request. */
export function loadHistoryRecoveryProgress(store: DeviceStore, person: string, node: string): HistoryRecoveryProgress | undefined {
  const storageKey = key(person, node), raw = store.get(storageKey)
  if (!raw) return
  try {
    const value = JSON.parse(raw) as Partial<HistoryRecoveryProgress>
    if (value.version !== 1 || value.person !== person || value.node !== node || !Array.isArray(value.windows) || value.windows.length > 64 ||
      value.windows.some(window => !validWindow(window))) throw new Error('invalid recovery progress')
    const names = new Set(value.windows.map(window => window.relay + '\u0000' + window.class))
    if (names.size !== value.windows.length) throw new Error('duplicate recovery progress')
    return { version: 1, person, node, windows: value.windows.map(window => ({ ...window })).sort(order) }
  } catch {
    store.remove(storageKey)
    return
  }
}

export function saveHistoryRecoveryProgress(store: DeviceStore, progress: HistoryRecoveryProgress): void {
  key(progress.person, progress.node)
  if (progress.version !== 1 || !Array.isArray(progress.windows) || progress.windows.length > 64 || progress.windows.some(window => !validWindow(window))) throw new Error('Invalid history recovery progress.')
  const names = new Set(progress.windows.map(window => window.relay + '\u0000' + window.class))
  if (names.size !== progress.windows.length) throw new Error('Duplicate history recovery progress.')
  store.set(key(progress.person, progress.node), JSON.stringify({ ...progress, windows: [...progress.windows].sort(order) }))
}

/** Initialise or reconcile progress to the currently configured readable
 * relays. New relays start at this explicit action's clock; removed relays
 * disappear rather than silently being dialled later. */
export function recoveryWindows(progress: HistoryRecoveryProgress | undefined, relays: readonly string[], until: number): HistoryRecoveryWindow[] {
  if (!Number.isSafeInteger(until) || until < 0) throw new Error('Invalid recovery end time.')
  const configured = [...new Set(relays)]
  if (configured.length === 0 || configured.length > 32 || configured.some(relay => typeof relay !== 'string' || !relay)) throw new Error('Use 1-32 canonical readable relays.')
  const held = new Map((progress?.windows ?? []).map(window => [window.relay + '\u0000' + window.class, window]))
  return configured.flatMap(relay => (['authored', 'addressed'] as const).map(className => {
    const saved = held.get(relay + '\u0000' + className)
    return saved ? { ...saved } : { relay, class: className, until }
  })).sort(order)
}

/** Advances only a receipt that completed EOSE without hitting its event cap.
 * A timeout, close, unavailable relay or limited response remains on exactly
 * the same window, making retry/attention visible rather than losing data. */
export function advanceRecoveryWindows(windows: readonly HistoryRecoveryWindow[], receipts: readonly HistoryImportReceipt[]): HistoryRecoveryWindow[] {
  const next = windows.map(window => ({ ...window }))
  for (const receipt of receipts) {
    const index = next.findIndex(window => window.relay === receipt.relay && window.class === receipt.request.class && window.until === receipt.request.filter.until)
    if (index < 0 || receipt.terminal !== 'complete') continue
    const since = receipt.request.filter.since
    if (typeof since === 'number' && Number.isSafeInteger(since) && since >= 0) next[index]!.until = since
  }
  return next.sort(order)
}

function validWindow(value: unknown): value is HistoryRecoveryWindow {
  const window = value as Partial<HistoryRecoveryWindow>
  return !!window && typeof window.relay === 'string' && window.relay.length > 0 &&
    (window.class === 'authored' || window.class === 'addressed') && Number.isSafeInteger(window.until) && window.until! >= 0
}

function order(a: HistoryRecoveryWindow, b: HistoryRecoveryWindow): number {
  return a.relay.localeCompare(b.relay) || a.class.localeCompare(b.class)
}
