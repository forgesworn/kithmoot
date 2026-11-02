import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { signNodeRoom, readNodeRoom, signNodeClosure, readNodeClosure } from '@forgesworn/fold-kit/node-room'
import { buildGrant, buildReset, buildRevocation, parseGroupEvent, type ParsedGrant } from './group-grants.js'
import { localIdentity } from './identity.js'
import { openNodeDeviceAccess, type NodeDeviceSnapshot } from './node-device-access.js'

const NOW = 1_900_000_000
function fixture() {
  let clock = NOW, saved: NodeDeviceSnapshot | undefined, failure = false
  const authoritySk = generateSecretKey(), device = localIdentity(generateSecretKey()), room = '13'.repeat(32)
  const node = readNodeRoom(signNodeRoom({ authoritySk, room, serviceKey: getPublicKey(generateSecretKey()), origin: 'https://node.example', now: NOW }), NOW)!
  const grant = buildGrant({ authoritySk, roomId: room, device: device.pubkey, server: 'node.example', scopes: ['turn', 'relay-read', 'relay-write'],
    grantId: '01'.repeat(16), createdAt: NOW, expiration: NOW + 7200 })
  const parsed = parseGroupEvent(grant); if (!parsed.ok) throw Error('fixture')
  let reply: unknown = { state: 'active', event: grant, offer: { v: 1, endpoint: node.origin, token: 'A'.repeat(43), expiresAt: NOW + 86400 } }
  const fetcher = vi.fn(async () => new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const store = { load: async () => structuredClone(saved), save: vi.fn(async (value: NodeDeviceSnapshot) => {
    if (failure) throw Error('disk unavailable'); saved = structuredClone(value)
  }) }
  const options = { fetcher, now: () => clock, onClosure: vi.fn() }
  return { authoritySk, device, room, node, grant, parsed: parsed.parsed as ParsedGrant, fetcher, store, options,
    reply: (value: unknown) => { reply = value }, failSave: () => { failure = true }, advance: (seconds: number) => { clock += seconds } }
}
describe('durable node device access', () => {
  it('persists admission before making requests and keeps revoked ids blocked after restart and replay', async () => {
    const f = fixture(), controller = await openNodeDeviceAccess(f.node, f.device, f.grant, f.store, f.options)
    expect(f.store.save).toHaveBeenCalledTimes(1); expect(f.fetcher).not.toHaveBeenCalled(); expect(controller.allowed()).toBe(false)
    await controller.refresh(); expect(controller.allowed()).toBe(true)
    await controller.observe(buildRevocation(f.parsed, f.authoritySk, NOW + 1))
    expect(controller.allowed()).toBe(false); controller.close()
    const restored = await openNodeDeviceAccess(f.node, f.device, f.grant, f.store, f.options)
    try {
      await expect(restored.refresh()).rejects.toMatchObject({ reason: 'refused' })
      expect(restored.allowed()).toBe(false); expect(f.options.onClosure).not.toHaveBeenCalled()
    } finally { restored.close() }
  })
  it('preserves a reset floor without deleting, and deletes only on the explicit keeper closure', async () => {
    const f = fixture(), controller = await openNodeDeviceAccess(f.node, f.device, f.grant, f.store, f.options)
    try {
      await controller.refresh()
      const reset = buildReset({ authoritySk: f.authoritySk, roomId: f.room, server: 'node.example', createdAt: NOW + 1 })
      await controller.observe(reset); expect(controller.allowed()).toBe(false)
      await expect(controller.refresh()).rejects.toMatchObject({ reason: 'refused' }); expect(f.options.onClosure).not.toHaveBeenCalled()
      const closure = signNodeClosure({ node: f.node, authoritySk: f.authoritySk, operation: 'ab'.repeat(16), now: NOW + 1 })
      f.reply({ state: 'closed', proof: readNodeClosure(closure, f.node, NOW + 1) })
      expect((await controller.refresh()).state).toBe('closed'); expect(f.options.onClosure).toHaveBeenCalledExactlyOnceWith(structuredClone(closure))
      expect(f.store.save.mock.calls.at(-1)?.[0].closure).toEqual(structuredClone(closure))
    } finally { controller.close() }
  })
  it('blocks retained access on a storage failure and sends no later requests', async () => {
    const f = fixture(), controller = await openNodeDeviceAccess(f.node, f.device, f.grant, f.store, f.options)
    try {
      await controller.refresh(); expect(controller.allowed()).toBe(true)
      f.failSave()
      await expect(controller.observe(buildRevocation(f.parsed, f.authoritySk, NOW + 1))).rejects.toMatchObject({ reason: 'unavailable' })
      expect(controller.allowed()).toBe(false)
      await expect(controller.refresh()).rejects.toMatchObject({ reason: 'refused' }); expect(f.fetcher).toHaveBeenCalledTimes(1)
      expect(f.options.onClosure).not.toHaveBeenCalled()
    } finally { controller.close() }
  })
  it('uses a persisted renewal when the original admission grant has expired', async () => {
    const f = fixture(), controller = await openNodeDeviceAccess(f.node, f.device, f.grant, f.store, f.options)
    const renewed = buildGrant({ authoritySk: f.authoritySk, roomId: f.room, device: f.device.pubkey, server: 'node.example', scopes: ['turn', 'relay-read', 'relay-write'],
      grantId: f.parsed.grantId, createdAt: NOW + 3600, expiration: NOW + 10800 })
    await controller.observe(renewed); controller.close(); f.advance(8000)
    f.reply({ state: 'active', event: renewed, offer: { v: 1, endpoint: f.node.origin, token: 'A'.repeat(43), expiresAt: NOW + 86400 } })
    const restored = await openNodeDeviceAccess(f.node, f.device, f.grant, f.store, f.options)
    try { await restored.refresh(); expect(restored.allowed()).toBe(true) } finally { restored.close() }
  })
  it('recovers a later signed close when the old admission grant has been pruned after a long absence', async () => {
    const f = fixture(), controller = await openNodeDeviceAccess(f.node, f.device, f.grant, f.store, f.options)
    controller.close(); f.advance(20 * 86400)
    const closure = signNodeClosure({ node: f.node, authoritySk: f.authoritySk, operation: 'ab'.repeat(16), now: NOW + 19 * 86400 })
    f.reply({ state: 'closed', proof: readNodeClosure(closure, f.node, NOW + 20 * 86400) })
    const restored = await openNodeDeviceAccess(f.node, f.device, f.grant, f.store, f.options)
    try {
      expect(f.store.save.mock.calls.at(-1)?.[0].grants.events).toEqual([])
      expect(restored.allowed()).toBe(false)
      expect((await restored.refresh()).state).toBe('closed')
      expect(f.options.onClosure).toHaveBeenCalledExactlyOnceWith(structuredClone(closure))
      expect(restored.allowed()).toBe(false)
    } finally { restored.close() }
  })
})
