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
const selection = { leaf: target.leafId, expectedStorageKeeper: keeper, box, permission }
class Tx {
  values = new Map<string, Uint8Array>()
  async readVault(id: string) { return this.values.get(id)?.slice() }
  async putVault(id: string, bytes: Uint8Array) { this.values.set(id, bytes.slice()) }
}
describe('Admin2 native roster storage request binding', () => {
  it('requires a keeper pin independently from a valid permission signature', () => {
    expect(adminStorageRequestTarget(sender, local, [target], selection, now)).toEqual(target)
    expect(() => adminStorageRequestTarget(sender, local, [target], { ...selection, expectedStorageKeeper: '55'.repeat(32) }, now)).toThrow('expected storage keeper')
  })
  it.each(['self','nonmember','pending','person','home','expired','local-device'] as const)('refuses %s native targets', change => {
    const member = { ...target, ...(change === 'self' ? { own: true } : change === 'pending' ? { pending: true } : change === 'person' ? { identity: '55'.repeat(32) } : change === 'home' ? { homeBox: '55'.repeat(32) } : change === 'expired' ? { bindingExpiresAt: now } : change === 'local-device' ? { device: local } : {}) }
    expect(() => adminStorageRequestTarget(sender, local, change === 'nonmember' ? [] : [member], selection, now)).toThrow('committed nonlocal')
  })
  it('refuses an expired permission or permission naming a different transmitter', () => {
    expect(() => adminStorageRequestTarget(sender, '55'.repeat(32), [target], selection, now)).toThrow('transmitting device')
    expect(() => adminStorageRequestTarget(sender, local, [target], selection, now + 3600)).toThrow('expired')
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
