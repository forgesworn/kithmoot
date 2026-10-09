import { describe, expect, it } from 'vitest'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { withMlsRendezvous } from './mls-rendezvous-custody.js'
import { StoredRendezvousChild, type RendezvousVault, type RendezvousReceipt } from './rendezvous-vault.js'
const scalar = new Uint8Array(32).fill(3), peer = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(4)))
const receipt: RendezvousReceipt = { identity: '11'.repeat(32), device: '22'.repeat(32), rendezvousPubkey: bytesToHex(schnorr.getPublicKey(scalar)), index: 7, expiresAt: 1300 }
const req = { v: 1 as const, operation: '44'.repeat(32), peer_rz: peer, expires_at: 1200 }
function fixture(change: Partial<RendezvousReceipt> = {}, childScalar = scalar) {
  let clock = 1000, live = true, app = true, closed = false, afterRead = () => {}
  const child = new StoredRendezvousChild({ ...receipt, ...change }, childScalar)
  const source = { async withCurrentChild(_identity: string, _device: string, work: any) { try { await Promise.resolve(); afterRead(); return await work(child, () => live && !closed, () => live) } finally { closed = true; child.wipe() } } } as unknown as RendezvousVault
  return { run: <T>(work: Parameters<typeof withMlsRendezvous<T>>[4]) => withMlsRendezvous(source, receipt, () => clock, () => app, work), afterRead: (fn: () => void) => { afterRead = fn }, clock: (n: number) => { clock = n }, invalidate: () => { live = false }, account: () => { app = false } }
}
describe('typed rendezvous custody', () => {
  it('derives the provisioned child, exposes only an opaque answer, and consumes it once', async () => {
    const f = fixture()
    await f.run(async c => {
      const answer = c.derive(req)
      expect(JSON.stringify(answer)).toBe('{"type":"mls-rendezvous-answer"}')
      const shared = c.accept(req, answer)
      expect(shared).toEqual(secp256k1.getSharedSecret(scalar, hexToBytes('02' + peer)).slice(1))
      shared.fill(0)
      expect(() => c.accept(req, answer)).toThrow('replay')
    })
  })
  for (const key of ['identity', 'device', 'rendezvousPubkey', 'index', 'expiresAt'] as const) it(`rejects a substituted receipt ${key}`, async () => {
    const f = fixture({ [key]: typeof receipt[key] === 'number' ? 9 : 'ff'.repeat(32) })
    await expect(f.run(async () => true)).rejects.toThrow('stale-rendezvous')
  })
  it('checks the actual scalar against the receipt', async () => {
    await expect(fixture({}, new Uint8Array(32).fill(5)).run(async c => c.derive(req))).rejects.toThrow('stale-rendezvous')
  })
  for (const mode of ['child', 'account', 'expiry', 'deadline'] as const) it(`rejects an answer after ${mode}`, async () => {
    const f = fixture()
    await f.run(async c => {
      const a = c.derive(req)
      if (mode === 'child') f.invalidate()
      if (mode === 'account') f.account()
      if (mode === 'expiry') f.clock(1300)
      if (mode === 'deadline') f.clock(1201)
      expect(() => c.accept(req, a)).toThrow(mode === 'deadline' ? 'expired' : 'stale-rendezvous')
    })
  })
  it('rejects forged answers and changed operation, peer or expiry', async () => {
    await fixture().run(async c => {
      const a = c.derive(req)
      expect(() => c.accept(req, { ...a })).toThrow('replay')
      for (const changed of [{ operation: '55'.repeat(32) }, { peer_rz: '66'.repeat(32) }, { expires_at: 1199 }]) expect(() => c.accept({ ...req, ...changed }, a)).toThrow('replay')
      expect(() => c.derive(req)).toThrow('busy')
      c.accept(req, a).fill(0)
    })
  })
  it('does not leave usable custody after its scope ends', async () => {
    const c = await fixture().run(async c => c)
    expect(c.current()).toBe(false)
    expect(() => c.derive(req)).toThrow('stale-rendezvous')
  })
  for (const changed of [{ peer_rz: receipt.rendezvousPubkey }, { peer_rz: 'ff'.repeat(32) }, { expires_at: 999 }, { expires_at: 1601 }, { expires_at: NaN }, { extra: true }]) it(`refuses malformed request ${JSON.stringify(changed)}`, async () => {
    await expect(fixture().run(async c => c.derive({ ...req, ...changed }))).rejects.toThrow('malformed')
  })
  it('checks expiry again after awaiting the child source', async () => {
    const f = fixture(); f.afterRead(() => f.clock(1300))
    await expect(f.run(async c => c.derive(req))).rejects.toThrow('stale-rendezvous')
  })
})
