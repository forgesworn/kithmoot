import { describe, expect, it } from 'vitest'
import { validateMlsPendingAdd, mlsPendingAddMember, mlsPendingAddMatches, type MlsPendingAdd } from './mls-pending-add.js'

const hex = (byte: string) => byte.repeat(32)
const candidate = (): MlsPendingAdd => ({ identity: hex('11'), device: hex('22'), credentialId: hex('33'), credentialExpiresAt: 2000, bindingExpiresAt: 1800,
  route: { packageId: hex('44'), welcomeMailbox: hex('55'), homeBox: hex('66'), leafId: hex('77'), expiresAt: 1600 },
  proposal: { generation: '4', recordId: hex('88'), mailbox: hex('99'), envelopeHash: hex('aa'), epoch: '2', attempt: 0 } })
describe('authenticated pending Add records', () => {
  it('retains immutable candidate/proposal binding alongside separate carrier and witnessed readback facts', () => {
    const value = candidate(), frozen = structuredClone(value)
    validateMlsPendingAdd(value)
    value.carrier = { attempt: 1, recordId: hex('bb'), mailbox: hex('cc'), envelopeHash: hex('dd') }
    value.readback = { kind: 'current-observed', generation: '6', envelopeHash: hex('ee') }
    validateMlsPendingAdd(value)
    expect(value.proposal).toEqual(frozen.proposal); expect(value.route).toEqual(frozen.route)
    value.readback.kind = 'proposal-committed'; validateMlsPendingAdd(value)
  })
  it('does not use a pending/current status flag as a substitute for an exact member binding', () => {
    const value = candidate(), member = mlsPendingAddMember(value)
    expect(member.pending).toBe(true); expect(mlsPendingAddMatches(value, { ...member, pending: false })).toBe(true)
    for (const key of ['leafId', 'identity', 'device', 'homeBox', 'bindingExpiresAt'] as const) {
      expect(mlsPendingAddMatches(value, { ...member, [key]: key === 'bindingExpiresAt' ? 1801 : hex('ff') })).toBe(false)
    }
    expect(mlsPendingAddMatches(value, { ...member, own: true })).toBe(false)
  })
  it('refuses coercible, noncanonical, ambiguous or extra candidate/proposal/readback authority', () => {
    const invalid: ((value: any) => void)[] = [
      v => { v.device += '\n' }, v => { v.identity = new String(v.identity) }, v => { v.credentialId = v.credentialId.toUpperCase().replaceAll('3', 'A') },
      v => { v.route.extra = true }, v => { v.proposal.epoch = '02' }, v => { v.proposal.generation = '0' },
      v => { v.proposal.generation = '9223372036854775808' }, v => { v.proposal.attempt = -1 }, v => { v.proposal.envelopeHash = undefined },
      v => { v.credentialExpiresAt = Number.MAX_SAFE_INTEGER + 1 }, v => { v.bindingExpiresAt = 0 },
      v => { v.carrier = { ...v.proposal, attempt: 1 } }, v => { v.carrier = { recordId: hex('bb'), mailbox: hex('cc'), envelopeHash: hex('dd'), attempt: 0 } },
      v => { v.readback = { kind: 'proposal-committed', generation: '4', envelopeHash: hex('ee') } },
      v => { v.readback = { kind: 'gone', generation: '5', envelopeHash: hex('ee') } },
    ]
    for (const corrupt of invalid) { const value = candidate(); corrupt(value); expect(() => validateMlsPendingAdd(value)).toThrow('Invalid authenticated pending Add') }
  })
})
