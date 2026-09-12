/** Durable ownership handoff for a quiet cadence lease. */
import type { CadenceLeaseRequest, CadenceReceipt } from '../../src/box-cadence.js'
import { serialiseCadenceBody } from '../../src/box-cadence.js'
import type { DeviceStore } from './device-store.js'

export const CADENCE_LEASE_PREFIX = 'kithmoot.cadence-lease.v1.'

export type CadenceOwnership = 'client-excluded' | 'box-owned' | 'ended'

export interface StoredCadenceLease {
  v: 1
  nodeId: string
  room: string
  device: string
  leaseId: string
  generation: number
  requestId: string
  requestBody: string
  startEpoch: number
  endEpoch: number
  counterLo: number
  counterHi: number
  ownership: CadenceOwnership
  receipt?: CadenceReceipt
  updatedAt: number
}

const HEX64 = /^[0-9a-f]{64}$/
const ID32 = /^[0-9a-f]{32}$/
const NODE52 = /^[a-z2-7]{52}$/

function keyOf(room: string, device: string, leaseId: string, generation: number): string {
  return `${CADENCE_LEASE_PREFIX}${room}.${device}.${leaseId}.${generation}`
}

function valid(value: unknown): value is StoredCadenceLease {
  if (!value || typeof value !== 'object') return false
  const x = value as Partial<StoredCadenceLease>
  return x.v === 1 && NODE52.test(String(x.nodeId)) && HEX64.test(String(x.room)) && HEX64.test(String(x.device)) &&
    ID32.test(String(x.leaseId)) && ID32.test(String(x.requestId)) && Number.isSafeInteger(x.generation) &&
    Number.isSafeInteger(x.startEpoch) && Number.isSafeInteger(x.endEpoch) && Number.isSafeInteger(x.counterLo) &&
    Number.isSafeInteger(x.counterHi) && typeof x.requestBody === 'string' && typeof x.updatedAt === 'number' &&
    (x.ownership === 'client-excluded' || x.ownership === 'box-owned' || x.ownership === 'ended')
}

export function cadenceLeases(store: DeviceStore, room?: string, device?: string): StoredCadenceLease[] {
  const leases: StoredCadenceLease[] = []
  const wanted = room === undefined ? CADENCE_LEASE_PREFIX : `${CADENCE_LEASE_PREFIX}${room}.${device ?? ''}`
  for (const key of store.keys()) {
    if (!key.startsWith(wanted)) continue
    try {
      const value: unknown = JSON.parse(store.get(key) ?? '')
      if (!valid(value)) throw new Error('invalid cadence lease state')
      if ((room === undefined || value.room === room) && (device === undefined || value.device === device)) leases.push(value)
    } catch { throw new Error('cadence lease state is damaged; refusing to reuse possibly delegated keys') }
  }
  return leases.sort((a, b) => a.startEpoch - b.startEpoch || a.generation - b.generation)
}

/**
 * Exclude the delegated counters on the client before any network request is
 * returned to the caller. A timeout never removes this record: retry the exact
 * request or ask the box for its exact lease status.
 */
export function prepareCadenceLease(store: DeviceStore, nodeId: string, request: CadenceLeaseRequest, now: number): StoredCadenceLease {
  if (!NODE52.test(nodeId) || request.server !== `ws://${nodeId}/events`) throw new Error('cadence lease does not match the pinned box')
  const requestBody = serialiseCadenceBody(request)
  const existing = cadenceLeases(store, request.room, request.device)
  const same = existing.find(value => value.leaseId === request.lease_id && value.generation === request.generation)
  if (same) {
    if (same.requestBody !== requestBody || same.nodeId !== nodeId) throw new Error('cadence request id was reused for different bytes')
    return same
  }
  const overlap = existing.some(value => value.ownership !== 'ended' && request.start_epoch < value.endEpoch && value.startEpoch < request.end_epoch && request.counter_lo < value.counterHi && value.counterLo < request.counter_hi)
  if (overlap) throw new Error('cadence lease overlaps locally excluded counters')
  const value: StoredCadenceLease = {
    v: 1, nodeId, room: request.room, device: request.device, leaseId: request.lease_id,
    generation: request.generation, requestId: request.request_id, requestBody,
    startEpoch: request.start_epoch, endEpoch: request.end_epoch,
    counterLo: request.counter_lo, counterHi: request.counter_hi,
    ownership: 'client-excluded', updatedAt: now,
  }
  store.set(keyOf(value.room, value.device, value.leaseId, value.generation), JSON.stringify(value))
  return value
}

export function acceptCadenceReceipt(store: DeviceStore, current: StoredCadenceLease, receipt: CadenceReceipt, now: number): StoredCadenceLease {
  if (receipt.v !== 1 || receipt.lease_id !== current.leaseId || receipt.generation !== current.generation || receipt.start_epoch !== current.startEpoch || receipt.end_epoch !== current.endEpoch) throw new Error('cadence receipt does not match the excluded lease')
  if (!['staged', 'active', 'cover', 'ended'].includes(receipt.state)) throw new Error('invalid cadence receipt state')
  const value: StoredCadenceLease = { ...current, ownership: receipt.state === 'ended' ? 'ended' : 'box-owned', receipt, updatedAt: now }
  store.set(keyOf(value.room, value.device, value.leaseId, value.generation), JSON.stringify(value))
  return value
}

export function cadenceExcludesCounter(leases: StoredCadenceLease[], epoch: number, counter: number): boolean {
  return leases.some(value => value.ownership !== 'ended' && value.startEpoch <= epoch && epoch < value.endEpoch && value.counterLo <= counter && counter < value.counterHi)
}

/** Every counter this phone must leave to its box in one epoch. */
export function cadenceReservedCounters(store: DeviceStore, room: string, device: string, epoch: number): number[] {
  const counters = new Set<number>()
  for (const lease of cadenceLeases(store, room, device)) {
    if (lease.ownership === 'ended' || epoch < lease.startEpoch || epoch >= lease.endEpoch) continue
    for (let counter = lease.counterLo; counter < lease.counterHi; counter++) counters.add(counter)
  }
  return [...counters].sort((a, b) => a - b)
}

export function forgetEndedCadenceLeases(store: DeviceStore, beforeEpoch: number): void {
  for (const value of cadenceLeases(store)) if (value.ownership === 'ended' && value.endEpoch <= beforeEpoch) store.remove(keyOf(value.room, value.device, value.leaseId, value.generation))
}
