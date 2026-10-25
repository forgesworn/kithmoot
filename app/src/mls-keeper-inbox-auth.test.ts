import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { BrowserPersonaCoordinator, type PersonaTransaction } from './mls-persona-coordinator.js'
import { CoordinatedMlsVault, BOX_METHOD } from './mls-coordinated-vault.js'
import { keeperInboxAuthRequest, keeperInboxDestination, type KeeperInboxAuthRequest, type KeeperInboxAuthConsent } from './mls-keeper-inbox-auth.js'

class MemoryTransaction implements PersonaTransaction {
  installation = '66'.repeat(32)
  vault = new Map<string, Uint8Array>()
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, bytes: Uint8Array) { this.vault.set(id, bytes.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}
async function fixture() {
  const secret = generateSecretKey(), identity = localIdentity(secret), keeperSecret = generateSecretKey(), keeper = getPublicKey(keeperSecret)
  const tx = new MemoryTransaction(), box = '78'.repeat(32)
  let now = 1_800_000_000, generation = 0, revision = '', allowed = true, held = false, afterRead: (() => void) | undefined
  const coordinate = async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    const value = await work(tx)
    afterRead?.()
    return held || !current() ? { state: 'pending', reason: 'stale', refused: false } : { state: 'active', value }
  }
  const coordinator = { transact: coordinate, readConfirmed: vi.fn(coordinate), invalidate() {} } as unknown as BrowserPersonaCoordinator
  const vault = new CoordinatedMlsVault(coordinator, { now: () => now, generation: () => generation,
    signals: { revision: () => revision, invalidate: () => { revision += 'x' } } })
  const ctx = () => vault.context('https://test', identity.pubkey)
  const enrolled = await vault.enrol(ctx(), identity, now + 86400)
  if (!enrolled.ok) throw new Error(enrolled.refusal)
  const device = enrolled.value.device
  const permission = (tags?: string[][], created_at = now, content = '') => finalizeEvent({ kind: 24242, created_at, content,
    tags: tags ?? [['t', 'keeper-inbox-deposit'], ['server', keeperInboxDestination(box)], ['device', device], ['grant', 'ab'.repeat(16)], ['expiration', String(now + 3600)], ['status', 'active']] }, keeperSecret)
  const request = (): KeeperInboxAuthRequest => ({ v: 1, box, keeper, permission: permission(), challenge: '34'.repeat(32), expires_at: now + 120 })
  const prompt = vi.fn(async (_operation: KeeperInboxAuthConsent) => 'approve' as const), current = () => allowed
  const sign = (r = request(), ask = prompt) => vault.signKeeperInboxAuthV1(ctx(), r, ask, current)
  const mutateRecord = (work: (r: any) => void) => { const [id, bytes] = [...tx.vault][0]!; const r = JSON.parse(new TextDecoder().decode(bytes)); work(r); tx.vault.set(id, new TextEncoder().encode(JSON.stringify(r))) }
  return { vault, ctx, sign, request, prompt, current, permission, device, keeper, box, coordinator, mutateRecord,
    now: () => now, clock: (n: number) => { now = n }, stop: () => { allowed = false }, swap: () => { generation++ }, hold: () => { held = true },
    afterRead: (work?: () => void) => { afterRead = work } }
}
const tagsWith = (event: Event, name: string, value: string) => event.tags.map(t => t[0] === name ? [name, value] : [...t])

describe('transmitting device keeper inbox AUTH', () => {
  it('produces only verified NIP-42 device AUTH at the vault clock and canonical Link destination', async () => {
    const f = await fixture(), req = f.request(), result = await f.sign(req)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.device).toBe(f.device)
    expect(verifyEvent(result.value.event)).toBe(true)
    expect(result.value.event).toMatchObject({ kind: 22242, content: '', created_at: f.now(), pubkey: f.device,
      tags: [['relay', keeperInboxDestination(f.box)], ['challenge', req.challenge]] })
    expect(f.prompt).toHaveBeenCalledOnce()
    expect(f.prompt.mock.calls[0]![0]).toMatchObject({ purpose: 'keeper-inbox-deposit-auth', principal: 'https://test', persona: f.ctx().persona,
      box: f.box, keeper: f.keeper, device: f.device, grant: 'ab'.repeat(16), permissionId: req.permission.id, deadline: req.expires_at,
      destination: keeperInboxDestination(f.box), current: expect.any(Function) })
    expect(await f.vault.acceptKeeperInboxAuthReply(req, result.value)).toEqual(result)
    expect(f.coordinator.readConfirmed).toHaveBeenCalledTimes(3)
  })
  it('always asks fresh purpose-specific consent despite saved box approval and changes no durable policy', async () => {
    const f = await fixture(), ctx = f.ctx()
    await f.vault.approve(ctx, { principal: ctx.principal, persona: ctx.persona, device: f.device, homeBox: f.box, method: BOX_METHOD })
    const before = await f.vault.overview(ctx)
    expect((await f.sign()).ok).toBe(true)
    expect((await f.sign()).ok).toBe(true)
    expect(f.prompt).toHaveBeenCalledTimes(2)
    expect(await f.vault.overview(ctx)).toEqual(before)
  })
  it.each(['content', 'kind', 'signature', 'extra-tag', 'duplicate-tag', 'tag-width', 'revoked', 'wrong-device', 'wrong-server', 'wrong-keeper'] as const)('refuses %s permissions before consent', async change => {
    const f = await fixture(), req = f.request(), original = req.permission
    if (change === 'content') req.permission = f.permission(undefined, f.now(), 'payload')
    if (change === 'kind') req.permission = { ...original, kind: 1 }
    if (change === 'signature') req.permission = { ...original, sig: '00'.repeat(64) }
    if (change === 'extra-tag') req.permission = f.permission([...original.tags, ['p', f.keeper]])
    if (change === 'duplicate-tag') req.permission = f.permission(original.tags.map(t => t[0] === 'status' ? ['grant', 'ab'.repeat(16)] : t))
    if (change === 'tag-width') req.permission = f.permission(original.tags.map(t => t[0] === 'grant' ? [...t, 'x'] : t))
    if (change === 'revoked') req.permission = f.permission(tagsWith(original, 'status', 'revoked'))
    if (change === 'wrong-device') req.permission = f.permission(tagsWith(original, 'device', '56'.repeat(32)))
    if (change === 'wrong-server') req.permission = f.permission(tagsWith(original, 'server', keeperInboxDestination('90'.repeat(32))))
    if (change === 'wrong-keeper') req.keeper = '90'.repeat(32)
    expect((await f.sign(req)).ok).toBe(false); expect(f.prompt).not.toHaveBeenCalled()
  })
  it.each(['expired', 'too-long', 'future', 'leading-zero', 'negative', 'fractional', 'unsafe'] as const)('refuses %s permission time', async change => {
    const f = await fixture(), req = f.request()
    const times = { expired: String(f.now()), 'too-long': String(f.now() + 30 * 86400 + 1), future: String(f.now() + 3600),
      'leading-zero': '0' + String(f.now() + 3600), negative: '-1', fractional: '1.5', unsafe: '9007199254740992' }
    req.permission = f.permission(tagsWith(req.permission, 'expiration', times[change]), f.now() + (change === 'future' ? 301 : 0))
    expect((await f.sign(req)).ok).toBe(false); expect(f.prompt).not.toHaveBeenCalled()
  })
  it('accepts backend maximum future skew and maximum permission lifetime', async () => {
    const f = await fixture(), req = f.request()
    req.permission = f.permission(tagsWith(req.permission, 'expiration', String(f.now() + 30 * 86400)), f.now() + 300)
    expect((await f.sign(req)).ok).toBe(true)
  })
  it.each([0, -1, 121, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('refuses invalid deadline offset %s', async offset => {
    const f = await fixture(), req = { ...f.request(), expires_at: f.now() + offset }
    expect((await f.sign(req)).ok).toBe(false); expect(f.prompt).not.toHaveBeenCalled()
  })
  it('rejects caller AUTH fields, malformed identifiers and extra wire keys', async () => {
    const f = await fixture(), req = f.request()
    for (const bad of [{ ...req, box: 'AB'.repeat(32) }, { ...req, challenge: req.challenge + '\n' }, { ...req, keeper: 'bad' },
      { ...req, created_at: f.now() }, { ...req, relay: keeperInboxDestination(f.box) }, { ...req, event: {} }, null]) expect(keeperInboxAuthRequest(bad)).toBeUndefined()
  })
  it.each(['withdrawal', 'pause', 'account', 'credential', 'expiry', 'deadline', 'clock', 'witness'] as const)('rechecks %s after prompt and releases no late signature', async change => {
    const f = await fixture(), req = f.request()
    const ask = vi.fn(async () => {
      if (change === 'withdrawal' || change === 'pause') f.stop()
      if (change === 'account') f.swap()
      if (change === 'credential') f.mutateRecord(r => r.policy.revoked.push(r.device.credentialId))
      if (change === 'expiry') f.clock(f.now() + 86400)
      if (change === 'deadline') f.clock(req.expires_at)
      if (change === 'clock') f.clock(f.now() - 1)
      if (change === 'witness') f.hold()
      return 'approve' as const
    })
    expect((await f.sign(req, ask)).ok).toBe(false)
  })
  it('invalidates fresh AUTH consent when an existing box approval is withdrawn during the prompt', async () => {
    const f = await fixture(), ctx = f.ctx()
    const scope = { principal: ctx.principal, persona: ctx.persona, device: f.device, homeBox: f.box, method: BOX_METHOD } as const
    await f.vault.approve(ctx, scope)
    const result = await f.sign(f.request(), vi.fn(async () => {
      expect((await f.vault.withdraw(ctx, scope)).ok).toBe(true)
      return 'approve' as const
    }))
    expect(result).toEqual({ ok: false, refusal: 'stale' })
  })
  it('bounds simultaneous duplicate operations and releases the reservation after denial', async () => {
    const f = await fixture(), req = f.request()
    let ready!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    const pending = f.sign(req, vi.fn(async () => { ready(); await waiting; return 'approve' as const }))
    await started
    expect(await f.sign(req)).toEqual({ ok: false, refusal: 'busy' })
    f.stop(); release()
    expect(await pending).toEqual({ ok: false, refusal: 'stale' })
    const g = await fixture(), next = g.request()
    expect(await g.vault.signKeeperInboxAuthV1(g.ctx(), next, async () => 'deny', g.current)).toEqual({ ok: false, refusal: 'denied' })
    expect((await g.sign(next)).ok).toBe(true)
  })
  it('snapshots permission and request before awaiting consent', async () => {
    const f = await fixture(), req = f.request(), expected = structuredClone(req)
    const result = await f.sign(req, vi.fn(async () => { req.challenge = '98'.repeat(32); req.permission.tags[1]![1] = 'wss://elsewhere.test'; return 'approve' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.event.tags).toEqual([['relay', keeperInboxDestination(f.box)], ['challenge', expected.challenge]])
    expect((await f.vault.acceptKeeperInboxAuthReply(expected, result.value)).ok).toBe(true)
    expect((await f.vault.acceptKeeperInboxAuthReply(req, result.value)).ok).toBe(false)
  })
  it('requires the original reply object and exact request including permission and challenge', async () => {
    const f = await fixture(), req = f.request(), result = await f.sign(req)
    if (!result.ok) throw new Error(result.refusal)
    expect(await f.vault.acceptKeeperInboxAuthReply(req, structuredClone(result.value))).toEqual({ ok: false, refusal: 'unauthorised' })
    expect(await f.vault.acceptKeeperInboxAuthReply({ ...req, challenge: '98'.repeat(32) }, result.value)).toEqual({ ok: false, refusal: 'replay' })
    const permission = f.permission(tagsWith(req.permission, 'grant', 'cd'.repeat(16)))
    expect(await f.vault.acceptKeeperInboxAuthReply({ ...req, permission }, result.value)).toEqual({ ok: false, refusal: 'replay' })
    expect(await f.vault.acceptKeeperInboxAuthReply({ ...req, expires_at: req.expires_at - 1 }, result.value)).toEqual({ ok: false, refusal: 'replay' })
  })
  it.each(['permission', 'account', 'credential', 'deadline', 'clock', 'witness'] as const)('refuses a previously signed reply after %s changes', async change => {
    const f = await fixture(), req = f.request(), result = await f.sign(req)
    if (!result.ok) throw new Error(result.refusal)
    if (change === 'permission') f.stop()
    if (change === 'account') f.swap()
    if (change === 'credential') f.mutateRecord(r => r.policy.revoked.push(r.device.credentialId))
    if (change === 'deadline') f.clock(req.expires_at)
    if (change === 'clock') f.clock(f.now() - 1)
    if (change === 'witness') f.hold()
    expect((await f.vault.acceptKeeperInboxAuthReply(req, result.value)).ok).toBe(false)
  })
  it('rechecks operation and clock after confirmed read cleanup before release', async () => {
    const f = await fixture(), req = f.request()
    let reads = 0
    f.afterRead(() => { if (++reads === 2) f.stop() })
    expect(await f.sign(req)).toEqual({ ok: false, refusal: 'stale' })
    const g = await fixture(), other = g.request(); let moreReads = 0
    g.afterRead(() => { if (++moreReads === 2) g.clock(other.expires_at) })
    expect((await g.sign(other)).ok).toBe(false)
  })
  it('refuses a guard that changes account while returning true after consent', async () => {
    const f = await fixture(), req = f.request()
    let prompted = false
    const result = await f.vault.signKeeperInboxAuthV1(f.ctx(), req,
      async () => { prompted = true; return 'approve' },
      () => { if (prompted) f.swap(); return true })
    expect(result).toEqual({ ok: false, refusal: 'stale' })
  })
  it('refuses a guard that changes account while returning true at final signature release', async () => {
    const f = await fixture(), req = f.request()
    let reads = 0, releasing = false
    f.afterRead(() => { if (++reads === 2) releasing = true })
    const result = await f.vault.signKeeperInboxAuthV1(f.ctx(), req, f.prompt,
      () => { if (releasing) f.swap(); return true })
    expect(result).toEqual({ ok: false, refusal: 'stale' })
  })
  it('fails closed on thrown current guards and consent denial', async () => {
    const f = await fixture()
    expect(await f.vault.signKeeperInboxAuthV1(f.ctx(), f.request(), f.prompt, () => { throw new Error('closed') })).toEqual({ ok: false, refusal: 'stale' })
    expect(await f.vault.signKeeperInboxAuthV1(f.ctx(), f.request(), async () => 'deny', f.current)).toEqual({ ok: false, refusal: 'denied' })
  })
})
