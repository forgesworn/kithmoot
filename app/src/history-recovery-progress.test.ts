import { describe, expect, it } from 'vitest'
import type { HistoryImportReceipt } from '../../src/history-import.js'
import { memoryDeviceStore } from './device-store.js'
import { advanceRecoveryWindows, loadHistoryRecoveryProgress, recoveryWindows, saveHistoryRecoveryProgress } from './history-recovery-progress.js'

const person = 'a'.repeat(64), node = 'b'.repeat(64)
const receipt = (relay: string, className: 'authored' | 'addressed', terminal: HistoryImportReceipt['terminal']): HistoryImportReceipt => ({
  relay,
  request: { version: 1, class: className, person, filter: { kinds: [1], authors: [person], since: 70, until: 100, limit: 500 } },
  startedAt: 1, finishedAt: 2, terminal, accepted: 0, duplicate: 0, invalid: 0, rejected: 0,
})

describe('history recovery progress', () => {
  it('starts one account/node-bound window per configured relay and request class', () => {
    expect(recoveryWindows(undefined, ['wss://two', 'wss://one'], 100)).toEqual([
      { relay: 'wss://one', class: 'addressed', until: 100 }, { relay: 'wss://one', class: 'authored', until: 100 },
      { relay: 'wss://two', class: 'addressed', until: 100 }, { relay: 'wss://two', class: 'authored', until: 100 },
    ])
  })

  it('advances only real EOSE receipts and leaves timeout, close and limit on the same window', () => {
    const windows = recoveryWindows(undefined, ['wss://one'], 100)
    expect(advanceRecoveryWindows(windows, [receipt('wss://one', 'authored', 'complete'), receipt('wss://one', 'addressed', 'limited')])).toEqual([
      { relay: 'wss://one', class: 'addressed', until: 100 }, { relay: 'wss://one', class: 'authored', until: 70 },
    ])
    expect(advanceRecoveryWindows(windows, [receipt('wss://one', 'authored', 'timeout'), receipt('wss://one', 'addressed', 'closed')])).toEqual(windows)
  })

  it('persists only well-formed state for the exact account and box', () => {
    const store = memoryDeviceStore(), progress = { version: 1 as const, person, node, windows: recoveryWindows(undefined, ['wss://one'], 100) }
    saveHistoryRecoveryProgress(store, progress)
    expect(loadHistoryRecoveryProgress(store, person, node)).toEqual(progress)
    expect(loadHistoryRecoveryProgress(store, person, 'c'.repeat(64))).toBeUndefined()
    store.set('kithmoot.history-recovery.v1.' + person + '.' + node, '{bad')
    expect(loadHistoryRecoveryProgress(store, person, node)).toBeUndefined()
  })
})
