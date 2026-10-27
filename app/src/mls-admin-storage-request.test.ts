import { describe, expect, it } from 'vitest'
import { base32nopad } from '@scure/base'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { adminStorageRequestTarget, checkAdminStorageDelivery, retainAdminStorageRequest } from './mls-admin-storage-request.js'
import { mlsBoxNode } from './mls-grant-ledger.js'
import { mlsStandaloneRevocationOperation } from './mls-revocation-binding.js'
import type { PersonaTransaction } from './mls-persona-coordinator.js'
const key = generateSecretKey(), keeper = getPublicKey(key), sender = '11'.repeat(32), local = '22'.repeat(32), now = 1_800_000_000
const box = { routeId: 'storage', eventUrl: `ws://${base32nopad.encode(new Uint8Array(32).fill(44)).toLowerCase()}/events` }, node = mlsBoxNode(box)
const target = { leafId: '33'.repeat(32), identity: sender, device: '44'.repeat(32), homeBox: node, bindingExpiresAt: now + 1000, own: false, pending: false }
const permission = finalizeEvent({ kind: 24242, created_at: now, content: '', tags: [['t','keeper-inbox-deposit'], ['server',box.eventUrl], ['device',local], ['grant','ab'.repeat(16)], ['expiration',String(now + 3600)], ['status','active']] }, key)
const own = { ...target, leafId: '66'.repeat(32), device: local, own: true }
const selection = { leaf: target.leafId, expectedStorageKeeper: keeper, box, permission }
class Tx {
  values = new Map<string, Uint8Array>()
  async readVault(id: string) { return this.values.get(id)?.slice() }
  async putVault(id: string, bytes: Uint8Array) { this.values.set(id, bytes.slice()) }
}
describe('Admin2 native roster storage request binding', () => {
  it('requires a keeper pin independently from a valid permission signature', () => {
    expect(adminStorageRequestTarget(sender, local, [own, target], selection, now)).toEqual(target)
    expect(() => adminStorageRequestTarget(sender, local, [own, target], { ...selection, expectedStorageKeeper: '55'.repeat(32) }, now)).toThrow('expected storage keeper')
  })
  it.each(['self','nonmember','pending','person','home','expired','local-device'] as const)('refuses %s native targets', change => {
    const member = { ...target, ...(change === 'self' ? { own: true } : change === 'pending' ? { pending: true } : change === 'person' ? { identity: '55'.repeat(32) } : change === 'home' ? { homeBox: '55'.repeat(32) } : change === 'expired' ? { bindingExpiresAt: now } : change === 'local-device' ? { device: local } : {}) }
    expect(() => adminStorageRequestTarget(sender, local, change === 'nonmember' ? [own] : [own, member], selection, now)).toThrow(change === 'self' ? 'local leaf' : 'committed nonlocal')
  })
  it('refuses an expired permission or permission naming a different transmitter', () => {
    expect(() => adminStorageRequestTarget(sender, '55'.repeat(32), [own, target], selection, now)).toThrow('transmitting device')
    expect(() => adminStorageRequestTarget(sender, local, [own, target], selection, now + 3600)).toThrow('expired')
  })
  it.each([now - 1, now])('refuses own native binding expiry %s without changing retained intent', async expiration => {
    const tx = new Tx() as unknown as PersonaTransaction
    await retainAdminStorageRequest(tx, sender, local, target, selection)
    const before = structuredClone([...(tx as unknown as Tx).values])
    expect(() => adminStorageRequestTarget(sender, local, [{ ...own, bindingExpiresAt: expiration }, target], selection, now)).toThrow('local leaf')
    expect([...(tx as unknown as Tx).values]).toEqual(before)
  })
  it.each(['missing','duplicate','pending','wrong-device','wrong-person'] as const)('refuses %s own native leaf evidence', change => {
    const selectedOwn = { ...own, ...(change === 'pending' ? { pending: true } : change === 'wrong-device' ? { device: '55'.repeat(32) } : change === 'wrong-person' ? { identity: '55'.repeat(32) } : {}) }
    const native = change === 'missing' ? [target] : change === 'duplicate' ? [own, selectedOwn, target] : [selectedOwn, target]
    expect(() => adminStorageRequestTarget(sender, local, native, selection, now)).toThrow('local leaf')
  })
  it('retains exact independent authority and refuses any public or substituted private destination', async () => {
    const tx = new Tx() as unknown as PersonaTransaction, operation = mlsStandaloneRevocationOperation(sender, keeper, target.device)
    await retainAdminStorageRequest(tx, sender, local, target, selection)
    const destination = { keeper, routeId: box.routeId, eventUrl: box.eventUrl, node, permissionId: permission.id, transmittingDevice: local }
    await expect(checkAdminStorageDelivery(tx, operation, sender, destination)).resolves.toBe(true)
    await expect(checkAdminStorageDelivery(tx, operation, sender)).rejects.toThrow('No public fallback')
    for (const field of ['keeper','routeId','eventUrl','node','permissionId','transmittingDevice'] as const) {
      await expect(checkAdminStorageDelivery(tx, operation, sender, { ...destination, [field]: '55'.repeat(32) })).rejects.toThrow('exact retained private route')
    }
    await expect(checkAdminStorageDelivery(tx, operation, '55'.repeat(32), destination)).rejects.toThrow('exact retained private route')
    await expect(retainAdminStorageRequest(tx, sender, local, target, { ...selection, box: { ...box, routeId: 'replacement' } })).rejects.toThrow('destination changed')
  })
})
