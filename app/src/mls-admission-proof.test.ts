import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { admissionProofInput, admissionProofPlan, admissionProofEvent, readAdmissionProofJournal, saveAdmissionProofJournal,
  ADMISSION_PROOF_RECORD, MAX_ADMISSION_PROOF_JOURNAL_BYTES, type AdmissionProofInput, type AdmissionProofEntry } from './mls-admission-proof.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import type { DeviceRecord } from './mls-vault.js'
const v = JSON.parse(readFileSync('node_modules/@forgesworn/fold-kit/vectors/mls-admission-v4.json', 'utf8'))
const c = JSON.parse(v.requestCore), e = c[11]
const device: DeviceRecord = { persona: c[7], device: c[9], credentialId: e[0], credentialExpiresAt: Number(e[4].find((t: string[]) => t[0] === 'expiration')[1]), scalar: '',
  credential: { pubkey: e[1], created_at: e[2], kind: e[3], tags: e[4], content: e[5], sig: e[6] } }
const ctx = { persona: c[7], principal: 'https://kithmoot.test', generation: 0, revision: 'fixture-revision' }
const input: AdmissionProofInput = { v: 4, role: 'engine-device', fragment: v.fragment, core: v.requestCore }
function tx(bytes?: Uint8Array) {
  let written: Uint8Array | undefined
  const transaction: PersonaTransaction = { installation: '45'.repeat(32), async readVault(id) { expect(id).toBe(ADMISSION_PROOF_RECORD); return bytes },
    async putVault(id, value) { expect(id).toBe(ADMISSION_PROOF_RECORD); written = value.slice() }, async dropVault() {}, async readSession() { return undefined }, async putSession() {}, async dropSession() {} }
  return { transaction, written: () => written }
}
const row = (): AdmissionProofEntry => { const plan = admissionProofPlan(input, ctx, device, [], v.now); return { principal: ctx.principal, role: input.role, operation: c[5], coreDigest: plan.consent.coreDigest,
  eventId: plan.consent.eventId, device: device.device, credentialId: device.credentialId, createdAt: c[15], deadline: c[16], generation: 0, revision: ctx.revision, reservation: '77'.repeat(32), outcome: 'pending' } }
describe('admission purpose input and current credential boundary', () => {
  it('snapshots mutable caller data before asynchronous use', () => { const caller = { ...input }; const saved = admissionProofInput(caller)!; caller.core = 'changed'; expect(saved.core).toBe(v.requestCore); expect(Object.isFrozen(saved)).toBe(true) })
  it('refuses accessors, symbols, proxies and extra fields without invoking getters', () => {
    let called = false
    const getter = { ...input }; Object.defineProperty(getter, 'core', { get() { called = true; throw new Error('secret') } })
    const values = [getter, { ...input, [Symbol()]: true }, new Proxy({}, { ownKeys() { throw new Error('secret') } }), { ...input, scalar: 'secret' }, { ...input, request: {} }, { ...input, role: 'keeper-device' }, { ...input, v: 3 }]
    for (const raw of values) expect(admissionProofInput(raw)).toBeUndefined()
    expect(called).toBe(false)
  })
  it('constructs the exact engine role proof from the independently composed vector', () => {
    const plan = admissionProofPlan(input, ctx, device, [], v.now)
    expect(plan.consent.coreDigest).toBe(v.requestDigest)
    expect(plan.consent.eventId).toBe(JSON.parse(v.requestProofs)[2][0])
    expect(plan.consent).not.toHaveProperty('fragment')
    expect(plan.key).not.toContain(v.fragment)
  })
  it.each(['revoked', 'different-device', 'different-id', 'different-expiry', 'different-account', 'alternate-credential'])("refuses %s current custody", mode => {
    const d = structuredClone(device), context = { ...ctx }
    const revoked: string[] = []
    if (mode === 'revoked') revoked.push(d.credentialId)
    if (mode === 'different-device') d.device = c[8]
    if (mode === 'different-id') d.credentialId = '88'.repeat(32)
    if (mode === 'different-expiry') d.credentialExpiresAt++
    if (mode === 'different-account') context.persona = c[3]
    if (mode === 'alternate-credential') d.credential.sig = '00'.repeat(64)
    expect(() => admissionProofPlan(input, context, d, revoked, v.now)).toThrow()
  })
  it('requires exclusive deadline, correct role, nominal request evidence and canonical core', () => {
    for (const changed of [{ ...input, role: 'keeper-device' as const }, { ...input, core: v.requestCore + ' ' }, { ...input, core: v.allowCore, role: 'keeper-device' as const, request: {} as any }]) expect(() => admissionProofPlan(changed, ctx, device, [], v.now)).toThrow()
    expect(() => admissionProofPlan(input, ctx, device, [], c[16])).toThrow()
    expect(() => admissionProofPlan(input, ctx, device, [], -1)).toThrow()
  })
})
describe('bounded separate admission journal', () => {
  it('copies writes and wipes owned read bytes; missing records remain empty', async () => {
    const t = tx(); await saveAdmissionProofJournal(t.transaction, ctx.persona, [row()])
    const bytes = t.written()!, before = bytes.slice()
    expect(await readAdmissionProofJournal(tx(bytes).transaction, ctx.persona)).toEqual([row()])
    expect(bytes.every(n => n === 0)).toBe(true); expect(before.some(n => n !== 0)).toBe(true)
    expect(await readAdmissionProofJournal(tx().transaction, ctx.persona)).toEqual([])
  })
  it.each(['version', 'persona', 'installation', 'extra', 'duplicate', 'principal-duplicate', 'proof', 'capacity'])("fences authenticated %s records and wipes plaintext", async mode => {
    const entry = row(), record: any = { version: 1, persona: ctx.persona, installation: '45'.repeat(32), entries: [entry] }
    if (mode === 'version') record.version = 2
    if (mode === 'persona') record.persona = c[3]
    if (mode === 'installation') record.installation = '99'.repeat(32)
    if (mode === 'extra') entry['unknown' as keyof AdmissionProofEntry] = true as never
    if (mode === 'duplicate') record.entries.push({ ...entry })
    if (mode === 'principal-duplicate') record.entries.push({ ...entry, principal: 'another' })
    if (mode === 'proof') entry.outcome = { event: JSON.parse(v.requestProofs)[0] }
    if (mode === 'capacity') record.entries = Array(1025).fill(entry)
    const bytes = new TextEncoder().encode(JSON.stringify(record))
    await expect(readAdmissionProofJournal(tx(bytes).transaction, ctx.persona)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    expect(bytes.every(n => n === 0)).toBe(true)
  })
  it('bounds serialised bytes before parsing and wipes oversized data', async () => {
    const bytes = new Uint8Array(MAX_ADMISSION_PROOF_JOURNAL_BYTES + 1).fill(32)
    await expect(readAdmissionProofJournal(tx(bytes).transaction, ctx.persona)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    expect(bytes.every(n => n === 0)).toBe(true)
  })
  it('rejects forged verification-cache events and retained wrong proof roles', () => {
    const proof = JSON.parse(v.requestProofs)[2]; proof[6] = '00'.repeat(64)
    expect(() => admissionProofEvent(JSON.stringify(proof))).toThrow()
  })
})
