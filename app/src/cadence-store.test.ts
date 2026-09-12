import { describe, expect, it } from 'vitest'
import vectors from '../../vectors/cadence-v1.json'
import type { CadenceLeaseRequest, CadenceReceipt } from '../../src/box-cadence.js'
import { memoryDeviceStore } from './device-store.js'
import {
  CADENCE_LEASE_PREFIX,
  acceptCadenceReceipt,
  cadenceExcludesCounter,
  cadenceLeases,
  cadenceReservedCounters,
  forgetEndedCadenceLeases,
  prepareCadenceLease,
} from './cadence-store.js'

const NODE = vectors.node_id
const NOW = vectors.now
const lease = JSON.parse(vectors.lease.body) as CadenceLeaseRequest
const receipt = (state = 'staged'): CadenceReceipt => ({
  v: 1, code: state, lease_id: lease.lease_id, generation: lease.generation, state,
  server_time: NOW, start_epoch: lease.start_epoch, end_epoch: lease.end_epoch,
  queue_count: 0, sent_item_ids: [], failed_item_ids: [],
})

describe('durable cadence ownership handoff', () => {
  it('excludes locally before a request leaves and preserves exact retry bytes after restart or timeout', () => {
    const store = memoryDeviceStore()
    const staged = prepareCadenceLease(store, NODE, lease, NOW)
    expect(staged.ownership).toBe('client-excluded')
    expect(staged.requestBody).toBe(vectors.lease.body)
    expect(cadenceExcludesCounter(cadenceLeases(store, lease.room, lease.device), lease.start_epoch, lease.counter_lo)).toBe(true)
    expect(cadenceReservedCounters(store, lease.room, lease.device, lease.start_epoch)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(cadenceReservedCounters(store, lease.room, lease.device, lease.end_epoch)).toEqual([])
    // A retry gets the same durable record and cannot silently make new bytes.
    expect(prepareCadenceLease(store, NODE, lease, NOW + 120)).toEqual(staged)
    expect(cadenceLeases(store, lease.room, lease.device)[0]?.ownership).toBe('client-excluded')
  })

  it('transfers ownership only on an exact receipt and retains it through cover', () => {
    const store = memoryDeviceStore()
    const staged = prepareCadenceLease(store, NODE, lease, NOW)
    expect(() => acceptCadenceReceipt(store, staged, { ...receipt(), generation: 2 }, NOW)).toThrow(/does not match/)
    const owned = acceptCadenceReceipt(store, staged, receipt(), NOW + 1)
    expect(owned.ownership).toBe('box-owned')
    expect(cadenceExcludesCounter([owned], lease.start_epoch, lease.counter_lo)).toBe(true)
    const cover = acceptCadenceReceipt(store, owned, receipt('cover'), NOW + 2)
    expect(cover.ownership).toBe('box-owned')
    const ended = acceptCadenceReceipt(store, cover, receipt('ended'), NOW + 3)
    expect(ended.ownership).toBe('ended')
    expect(cadenceExcludesCounter([ended], lease.start_epoch, lease.counter_lo)).toBe(false)
    forgetEndedCadenceLeases(store, lease.end_epoch)
    expect(cadenceLeases(store)).toEqual([])
  })

  it('refuses overlapping delegation, changed retry bytes and damaged ownership records', () => {
    const store = memoryDeviceStore()
    prepareCadenceLease(store, NODE, lease, NOW)
    expect(() => prepareCadenceLease(store, NODE, { ...lease, request_id: '5'.repeat(32) }, NOW)).toThrow(/different bytes/)
    expect(() => prepareCadenceLease(store, NODE, { ...lease, lease_id: '6'.repeat(32), request_id: '7'.repeat(32), generation: 2 }, NOW)).toThrow(/overlaps/)
    store.set(`${CADENCE_LEASE_PREFIX}${lease.room}.${lease.device}.bad.1`, '{}')
    expect(() => cadenceLeases(store, lease.room, lease.device)).toThrow(/possibly delegated keys/)
  })
})
