import { describe, expect, it } from 'vitest'
import { deliveryReceiptIdHash, type DeliveryReceipt } from '../../src/delivery-receipt.js'
import { memoryDeviceStore } from './device-store.js'
import { DeliveredLedger, MAX_DELIVERED_KEPT, RECEIPT_REFETCH_SLACK_SECONDS, deliveredView, deliveredWords, sendsDeliveryReceipts } from './delivery-receipts.js'

const ROOM = 'a'.repeat(64)
const SELF = '1'.repeat(64)
const ANA = '2'.repeat(64)
const BO = '3'.repeat(64)
const BOT = '4'.repeat(64)
const NOW = 1_800_000_000

const receipt = (participant: string, ids: string[], createdAt = NOW, agent = false): DeliveryReceipt =>
  ({ d: 'd'.repeat(64), createdAt, participant, device: participant, agent, got: ids.map(deliveryReceiptIdHash) })

function ledger(store = memoryDeviceStore(), changes: string[] = []) {
  return { l: new DeliveredLedger({ store, now: () => NOW * 1000, onChange: r => changes.push(r) }), store, changes }
}

describe('DeliveredLedger', () => {
  it('records who confirmed each of our messages, earliest first, one entry per person', () => {
    const { l, changes } = ledger()
    l.own(ROOM, { id: 'm1', sentAt: NOW - 10 })
    l.receipt(ROOM, receipt(BO, ['m1'], NOW - 2), SELF)
    l.receipt(ROOM, receipt(ANA, ['m1'], NOW - 5), SELF)
    l.receipt(ROOM, receipt(ANA, ['m1'], NOW - 1), SELF)
    expect(l.delivered(ROOM, 'm1').map(w => [w.participant, w.at])).toEqual([[ANA, NOW - 5], [BO, NOW - 2]])
    expect(changes.length).toBeGreaterThan(0)
  })

  it('never counts our own devices, and ignores hashes that are not ours', () => {
    const { l } = ledger()
    l.own(ROOM, { id: 'm1', sentAt: NOW })
    l.receipt(ROOM, receipt(SELF, ['m1']), SELF)
    l.receipt(ROOM, receipt(ANA, ['someone-else']), SELF)
    expect(l.delivered(ROOM, 'm1')).toEqual([])
    expect(l.delivered(ROOM, 'someone-else')).toEqual([])
  })

  it('matches a receipt that arrived before our message loaded', () => {
    const { l } = ledger()
    l.receipt(ROOM, receipt(ANA, ['m1']), SELF)
    expect(l.delivered(ROOM, 'm1')).toEqual([])
    l.own(ROOM, { id: 'm1', sentAt: NOW })
    expect(l.delivered(ROOM, 'm1').map(w => w.participant)).toEqual([ANA])
  })

  it('survives a reload, and drops confirmations older than seven days', () => {
    const store = memoryDeviceStore()
    const first = ledger(store).l
    first.own(ROOM, { id: 'new', sentAt: NOW })
    first.own(ROOM, { id: 'old', sentAt: NOW - 8 * 86_400 })
    first.receipt(ROOM, receipt(ANA, ['new', 'old'], NOW, true), SELF)
    const again = ledger(store).l
    expect(again.delivered(ROOM, 'new')).toEqual([{ participant: ANA, at: NOW, agent: true }])
    expect(again.delivered(ROOM, 'old')).toEqual([])
  })

  it('keeps at most a bounded number of messages', () => {
    const store = memoryDeviceStore()
    const { l } = ledger(store)
    for (let i = 0; i < MAX_DELIVERED_KEPT + 5; i++) { l.own(ROOM, { id: `m${i}`, sentAt: NOW - 1000 + i }); l.receipt(ROOM, receipt(ANA, [`m${i}`]), SELF) }
    const reloaded = ledger(store).l
    expect(reloaded.delivered(ROOM, 'm0')).toEqual([])
    expect(reloaded.delivered(ROOM, `m${MAX_DELIVERED_KEPT + 4}`)).toHaveLength(1)
  })

  it('asks relays from the newest receipt read, else from our oldest message, never past seven days', () => {
    const store = memoryDeviceStore()
    const { l } = ledger(store)
    expect(l.since(ROOM)).toBe(NOW)
    l.own(ROOM, { id: 'ancient', sentAt: NOW - 30 * 86_400 })
    expect(l.since(ROOM)).toBe(NOW)
    l.own(ROOM, { id: 'b', sentAt: NOW - 100 })
    l.own(ROOM, { id: 'a', sentAt: NOW - 3600 })
    // A reload, before any receipt was read: from our oldest recent message.
    expect(ledger(store).l.since(ROOM)).toBe(NOW - 3660)
    l.receipt(ROOM, receipt(ANA, ['x'], NOW - 50), SELF)
    expect(ledger(store).l.since(ROOM)).toBe(NOW - 50 - RECEIPT_REFETCH_SLACK_SECONDS)
  })

  it('forgets a room', () => {
    const store = memoryDeviceStore()
    const { l } = ledger(store)
    l.own(ROOM, { id: 'm1', sentAt: NOW })
    l.receipt(ROOM, receipt(ANA, ['m1']), SELF)
    l.forget(ROOM)
    expect(store.get(`kithmoot.delivered.v1.${ROOM}`)).toBeNull()
    expect(ledger(store).l.delivered(ROOM, 'm1')).toEqual([])
  })
})

describe('what the ticks say', () => {
  const name = (p: string) => ({ [ANA]: 'Ana', [BO]: 'Bo', [BOT]: 'Clerk' })[p] ?? 'someone'
  const by = (participant: string, agent = false) => ({ participant, at: NOW, agent })

  it('shows nothing until somebody who counts confirms', () => {
    expect(deliveredView([], { self: SELF, knownPeople: true })).toBeUndefined()
    expect(deliveredView([by(SELF)], { self: SELF, knownPeople: true })).toBeUndefined()
  })

  it('lists an agent, but lights the tick from one only when nobody else is known', () => {
    expect(deliveredView([by(BOT, true)], { self: SELF, knownPeople: true })).toBeUndefined()
    expect(deliveredView([by(BOT, true)], { self: SELF, knownPeople: false })).toEqual({ people: [], agents: [by(BOT, true)] })
    expect(deliveredView([by(ANA), by(BOT, true)], { self: SELF, knownPeople: true })?.agents).toHaveLength(1)
  })

  it('says Delivered between two people, and to how many in a link room', () => {
    const one = deliveredView([by(ANA)], { self: SELF, knownPeople: true })!
    expect(deliveredWords(one, name, 1)).toEqual({ text: 'Delivered', label: 'Delivered to Ana' })
    expect(deliveredWords(one, name, 4)).toEqual({ text: 'Delivered to 1', label: 'Delivered to 1' })
    const two = deliveredView([by(ANA), by(BO)], { self: SELF, knownPeople: true })!
    expect(deliveredWords(two, name, 4)).toEqual({ text: 'Delivered to 2', label: 'Delivered to 2' })
  })

  it('says "of N" and who is still waiting only with a fixed member list', () => {
    const view = deliveredView([by(ANA)], { self: SELF, knownPeople: true, members: [SELF, ANA, BO] })!
    expect(view).toMatchObject({ of: 2, waiting: [BO] })
    expect(deliveredWords(view, name, 2)).toEqual({ text: 'Delivered to 1 of 2', label: 'Delivered to 1 of 2' })
    const dm = deliveredView([by(ANA)], { self: SELF, knownPeople: true, members: [SELF, ANA] })!
    expect(deliveredWords(dm, name, 1)).toEqual({ text: 'Delivered', label: 'Delivered to Ana' })
  })
})

describe('the setting', () => {
  it('sends unless turned off', () => {
    const storage = (v: string | null) => ({ getItem: () => v })
    expect(sendsDeliveryReceipts(storage(null))).toBe(true)
    expect(sendsDeliveryReceipts(storage('on'))).toBe(true)
    expect(sendsDeliveryReceipts(storage('off'))).toBe(false)
    expect(sendsDeliveryReceipts({ getItem: () => { throw new Error('blocked') } })).toBe(true)
  })
})
