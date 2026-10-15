import { describe, expect, it } from 'vitest'
import { cadenceFixture, damageCadenceFixture, CADENCE_FAULTS, type CadenceFixtureMode } from '../../test/ordinary-cadence-fixture.js'
import { validateOrdinaryCadenceSnapshot as validate } from './ordinary-cadence-snapshot.js'
import { verifyDeviceCredential } from '../../src/credential.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'

describe('strict cadence delegation custody', () => {
  it.each<CadenceFixtureMode>(['client-excluded','staged','active','cover','ended','person','slot-one','expired','history'])('retains actual %s writer bytes without releasing ownership or making a request', async mode => {
    const f = await cadenceFixture(mode), before = [...f.records], result = validate(f.records, false, f.checks)
    expect(result.leases).toEqual([{ roomId: f.roomId, device: f.device, nodeId: 'a'.repeat(52), leaseId: f.request.lease_id,
      generation: 1, ownership: mode === 'client-excluded' ? 'client-excluded' : mode === 'ended' ? 'ended' : 'box-owned' }])
    expect([...f.records]).toEqual(before); expect(Object.isFrozen(result.leases[0])).toBe(true)
  })
  it('requires exact scoped persona binding and completed migration', async () => {
    const f = await cadenceFixture(), raw = f.records.get(f.name)!, scoped = new Map([['kithmoot.account.' + f.persona + '.' + f.name, raw]])
    expect(() => validate(scoped, false, f.checks)).toThrow(OrdinaryStateHold)
    expect(validate(scoped, true, f.checks).leases[0]!.account).toBe(f.persona)
    expect(() => validate(new Map([['kithmoot.account.' + 'a'.repeat(64) + '.' + f.name, raw]]), true, f.checks)).toThrow(OrdinaryStateHold)
    expect(() => validate(f.records, false, { ...f.checks, kind: 'tab' })).toThrow(OrdinaryStateHold)
  })
  it.each(CADENCE_FAULTS)('holds %s without discarding possibly delegated counters or changing retry bytes', async fault => {
    const f = await cadenceFixture('active'); damageCadenceFixture(f, f.records, fault)
    const before = [...f.records]; expect(() => validate(f.records, true, f.checks)).toThrow(OrdinaryStateHold); expect([...f.records]).toEqual(before)
  })
  it('holds a validly signed post-window credential even when its expiry covers the lease', async () => {
    const f = await cadenceFixture('active'); damageCadenceFixture(f, f.records, 'credential-post-window')
    const request = JSON.parse(JSON.parse(f.records.get(f.name)!).requestBody)
    const expiration = Number(request.credential.tags.find((tag: string[]) => tag[0] === 'expiration')[1])
    expect(request.credential.created_at).toBeGreaterThan(request.end_epoch * 3600)
    expect(verifyDeviceCredential(request.credential, { roomId: f.roomId, now: expiration - 1, acceptPerson: true }).ok).toBe(true)
    let visits = 0
    expect(() => validate(f.records, false, { ...f.checks, acceptsLease: () => { visits++; return true } })).toThrow(OrdinaryStateHold)
    expect(visits).toBe(0)
  })
  it('rejects client-excluded receipt and box-owned/ended rows missing their receipt', async () => {
    for (const ownership of ['client-excluded','box-owned','ended']) {
      const f = await cadenceFixture('active'), saved = JSON.parse(f.records.get(f.name)!); saved.ownership = ownership
      if (ownership !== 'client-excluded') delete saved.receipt
      f.records.set(f.name, JSON.stringify(saved)); expect(() => validate(f.records, false, f.checks)).toThrow(OrdinaryStateHold)
    }
  })
  it('rejects conflicting request or lease IDs across actual rooms before binding callbacks', async () => {
    for (const collision of ['request','lease']) {
      const f = await cadenceFixture('active'), other = await cadenceFixture('active', 6), saved = JSON.parse(other.records.get(other.name)!), body = JSON.parse(saved.requestBody)
      if (collision === 'lease') saved.requestId = body.request_id = '4'.repeat(32)
      saved.requestBody = JSON.stringify(body); f.records.set(other.name, JSON.stringify(saved)); let visits = 0
      expect(() => validate(f.records, false, { ...f.checks, acceptsLease: () => { visits++; return true } })).toThrow(OrdinaryStateHold); expect(visits).toBe(0)
    }
  })
  it('requires synchronous true from a pure/check-only callback and clones its complete input', async () => {
    const f = await cadenceFixture(), before = [...f.records]
    for (const acceptsLease of [undefined, () => false, () => { throw new Error('unavailable evidence') }, () => Promise.resolve(true)])
      expect(() => validate(f.records, false, { ...f.checks, acceptsLease } as any)).toThrow(OrdinaryStateHold)
    validate(f.records, false, { ...f.checks, acceptsLease: (request, scope) => {
      expect(Object.isFrozen(scope)).toBe(true); request.drop_keys.length = 0; request.credential.tags.length = 0; return true
    } }); expect([...f.records]).toEqual(before)
  })
  it('does not enter callbacks before a later malformed family row is checked', async () => {
    const f = await cadenceFixture(), other = await cadenceFixture('active', 6); f.records.set(other.name, '{'); let visits = 0
    expect(() => validate(f.records, false, { ...f.checks, acceptsLease: () => { visits++; return true } })).toThrow(OrdinaryStateHold); expect(visits).toBe(0)
  })
})
