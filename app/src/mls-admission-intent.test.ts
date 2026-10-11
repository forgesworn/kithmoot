import { describe, expect, it, vi } from 'vitest'
import { readAdmissionIntentLedger, reserveAdmissionIntent, bindAdmissionRequest, abandonAdmissionIntent,
  markAdmissionIntentUncertain, admissionIntentRecordId, AdmissionIntentHold, MAX_ADMISSION_INTENTS,
  MAX_ADMISSION_INTENT_BYTES, type AdmissionIntentLedger, type AdmissionRequestBinding } from './mls-admission-intent.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'

const hex = (n: number) => n.toString(16).padStart(64, '0')
const n = { persona: hex(1), rendezvous: hex(2) }, installation = hex(3)
const owner = { principal: 'https://kithmoot.test', browserDevice: hex(4), engineDevice: hex(5), credentialId: hex(6) }
const request: AdmissionRequestBinding = { root: hex(7), requestPubkey: hex(8), requestEventId: hex(9), requestCoreDigest: hex(10), pairedBox: hex(11), requestedExpiry: 200, createdAt: 100, deadline: 150 }
/** Synthetic EXISTING ledger fixture. This is not a bootstrap/fresh-R proof. */
const ledger = (): AdmissionIntentLedger => ({ version: 1, persona: n.persona, installation, rendezvous: n.rendezvous, nextCounter: '0', entries: [] })
function memory(record: unknown = ledger()) {
  let persisted = record === undefined ? undefined : new TextEncoder().encode(JSON.stringify(record)), writes = 0
  const readBuffers: Uint8Array[] = [], writeBuffers: Uint8Array[] = []
  const tx: PersonaTransaction = { installation, async readVault(id) {
    expect(id).toBe(admissionIntentRecordId(n.rendezvous)); const copy = persisted?.slice(); if (copy) readBuffers.push(copy); return copy
  }, async putVault(id, bytes) { expect(id).toBe(admissionIntentRecordId(n.rendezvous)); writes++; writeBuffers.push(bytes); persisted = bytes.slice() },
  async dropVault() { throw new Error('Deletion forbidden') }, async readSession() { return undefined }, async putSession() { throw new Error('No session writes') }, async dropSession() { throw new Error('No session deletion') } }
  return { tx, writes: () => writes, bytes: () => persisted?.slice(), readBuffers, writeBuffers, eraseFixture() { persisted = undefined } }
}
const held = (reason: string) => expect.objectContaining({ reason })

describe('existing admission ledger only', () => {
  it('holds absent legacy state without randomness, writes or implicit genesis', async () => {
    const m = memory(); m.eraseFixture(); const draw = vi.spyOn(crypto, 'getRandomValues')
    try { await expect(reserveAdmissionIntent(m.tx, n, owner, 100, 150)).rejects.toMatchObject(held('missing-ledger')); expect(m.writes()).toBe(0); expect(draw).not.toHaveBeenCalled() }
    finally { draw.mockRestore() }
  })
  it.each(['version', 'persona', 'installation', 'rendezvous', 'negative-zero', 'extra', 'signed-counter', 'noncanonical-counter', 'overflow', 'duplicate-operation', 'duplicate-challenge', 'duplicate-counter', 'wrong-state', 'bad-binding'])("fences authenticated %s data", async mode => {
    const good = memory(); const e = await reserveAdmissionIntent(good.tx, n, owner, 100, 150)
    const r: any = JSON.parse(new TextDecoder().decode(good.bytes()))
    if (['version', 'persona', 'installation', 'rendezvous'].includes(mode)) r[mode] = mode === 'version' ? 2 : hex(99)
    if (mode === 'negative-zero') r.entries[0].deadline = -0
    if (mode === 'extra') r.entries[0].secret = 'forbidden'
    if (mode === 'signed-counter') r.nextCounter = '-1'
    if (mode === 'noncanonical-counter') r.nextCounter = '01'
    if (mode === 'overflow') r.nextCounter = '18446744073709551616'
    if (mode.startsWith('duplicate-')) {
      const other = { ...e, operation: hex(20), challenge: hex(21), counter: '1' }; r.nextCounter = '2'
      if (mode === 'duplicate-operation') other.operation = e.operation
      if (mode === 'duplicate-challenge') other.challenge = e.challenge
      if (mode === 'duplicate-counter') other.counter = e.counter
      r.entries.push(other)
    }
    if (mode === 'wrong-state') r.entries[0].state = 'terminal'
    if (mode === 'bad-binding') { r.entries[0].state = 'request-bound'; r.entries[0].request = { ...request, deadline: 151 } }
    const m = memory(r)
    await expect(readAdmissionIntentLedger(m.tx, n)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    expect(m.writes()).toBe(0); expect(m.readBuffers.every(b => b.every(x => x === 0))).toBe(true)
  })
  it('burns 0 then 1 permanently; expiry, abandon and a replaced device never reset the R namespace', async () => {
    const m = memory(), first = await reserveAdmissionIntent(m.tx, n, owner, 100, 150)
    expect(first.counter).toBe('0'); expect(first.operation).toMatch(/^[0-9a-f]{64}$/); expect(first.challenge).not.toBe(first.operation)
    await expect(reserveAdmissionIntent(m.tx, n, owner, 200, 250)).rejects.toMatchObject(held('busy'))
    await abandonAdmissionIntent(m.tx, n, owner, first.operation)
    const second = await reserveAdmissionIntent(m.tx, n, { ...owner, engineDevice: hex(30), credentialId: hex(31) }, 200, 250)
    expect(second.counter).toBe('1'); const r = await readAdmissionIntentLedger(m.tx, n)
    expect(r.nextCounter).toBe('2'); expect(r.entries[0].engineDevice).toBe(owner.engineDevice); expect(r.entries[0].state).toBe('abandoned')
    expect(m.readBuffers.every(b => b.every(x => x === 0))).toBe(true); expect(m.writeBuffers.every(b => b.every(x => x === 0))).toBe(true)
  })
  it('reserves u64 MAX once, then exhausts without Number conversion or wrap', async () => {
    const r = ledger(); r.nextCounter = '18446744073709551615'; const m = memory(r)
    const last = await reserveAdmissionIntent(m.tx, n, owner, 100, 150); expect(last.counter).toBe(r.nextCounter)
    await abandonAdmissionIntent(m.tx, n, owner, last.operation)
    const before = m.bytes(), writes = m.writes()
    await expect(reserveAdmissionIntent(m.tx, n, owner, 200, 250)).rejects.toMatchObject(held('exhausted'))
    expect(m.bytes()).toEqual(before); expect(m.writes()).toBe(writes); expect((await readAdmissionIntentLedger(m.tx, n)).nextCounter).toBe('exhausted')
  })
  it('freezes an exact request before signing; exact retries are idempotent and all changed fields conflict', async () => {
    const m = memory(), e = await reserveAdmissionIntent(m.tx, n, owner, 100, 150)
    const b = await bindAdmissionRequest(m.tx, n, owner, e.operation, request), before = m.bytes(), writes = m.writes()
    expect(b.state).toBe('request-bound')
    const reversed = Object.fromEntries(Object.entries(request).reverse()) as unknown as AdmissionRequestBinding
    expect(await bindAdmissionRequest(m.tx, n, owner, e.operation, reversed)).toEqual(b); expect(m.writes()).toBe(writes)
    for (const k of Object.keys(request) as (keyof AdmissionRequestBinding)[]) {
      const changed = { ...request, [k]: typeof request[k] === 'number' ? (request[k] as number) + 1 : hex(99) }
      await expect(bindAdmissionRequest(m.tx, n, owner, e.operation, changed)).rejects.toThrow()
    }
    await expect(bindAdmissionRequest(m.tx, n, { ...owner, engineDevice: hex(99) }, e.operation, request)).rejects.toMatchObject(held('conflict'))
    await expect(abandonAdmissionIntent(m.tx, n, owner, e.operation)).rejects.toMatchObject(held('conflict'))
    expect(m.bytes()).toEqual(before); expect(m.writes()).toBe(writes)
  })
  it('uncertainty preserves the exact request and cannot rebind, abandon or free the counter', async () => {
    const m = memory(), e = await reserveAdmissionIntent(m.tx, n, owner, 100, 150)
    await expect(markAdmissionIntentUncertain(m.tx, n, owner, e.operation)).rejects.toMatchObject(held('conflict'))
    await bindAdmissionRequest(m.tx, n, owner, e.operation, request)
    const uncertain = await markAdmissionIntentUncertain(m.tx, n, owner, e.operation), writes = m.writes()
    expect(await markAdmissionIntentUncertain(m.tx, n, owner, e.operation)).toEqual(uncertain); expect(m.writes()).toBe(writes)
    await expect(bindAdmissionRequest(m.tx, n, owner, e.operation, request)).rejects.toMatchObject(held('conflict'))
    await expect(abandonAdmissionIntent(m.tx, n, owner, e.operation)).rejects.toMatchObject(held('conflict'))
    await expect(reserveAdmissionIntent(m.tx, n, owner, 200, 250)).rejects.toMatchObject(held('busy'))
    expect((await readAdmissionIntentLedger(m.tx, n)).nextCounter).toBe('1')
  })
  it('refuses accessors without invoking them and snapshots inputs before awaits', async () => {
    const m = memory(), getter = vi.fn(() => owner.principal), raw = { ...owner }
    Object.defineProperty(raw, 'principal', { get: getter })
    await expect(reserveAdmissionIntent(m.tx, n, raw, 100, 150)).rejects.toThrow('Invalid admission intent input'); expect(getter).not.toHaveBeenCalled()
    const mutable = { ...owner }, mutableNamespace = { ...n }
    const promise = reserveAdmissionIntent(m.tx, mutableNamespace, mutable, 100, 150); mutable.engineDevice = hex(99); mutableNamespace.rendezvous = hex(99)
    expect((await promise).engineDevice).toBe(owner.engineDevice)
  })
  it('holds zero/colliding/failed entropy without writing or consuming a counter', async () => {
    const m = memory(), e = await reserveAdmissionIntent(m.tx, n, owner, 100, 150)
    await abandonAdmissionIntent(m.tx, n, owner, e.operation); const before = m.bytes(), writes = m.writes()
    const draw = vi.spyOn(crypto, 'getRandomValues')
    try {
      draw.mockImplementation(bytes => { (bytes as Uint8Array).fill(0); return bytes })
      await expect(reserveAdmissionIntent(m.tx, n, owner, 100, 150)).rejects.toMatchObject(held('entropy'))
      draw.mockImplementation(bytes => { (bytes as Uint8Array).set(Buffer.from(e.operation, 'hex')); return bytes })
      await expect(reserveAdmissionIntent(m.tx, n, owner, 100, 150)).rejects.toMatchObject(held('entropy'))
      draw.mockImplementation(() => { throw new Error('RNG unavailable') })
      await expect(reserveAdmissionIntent(m.tx, n, owner, 100, 150)).rejects.toMatchObject(held('entropy'))
    } finally { draw.mockRestore() }
    expect(m.bytes()).toEqual(before); expect(m.writes()).toBe(writes)
  })
  it('holds at exactly 1024 permanent rows, including abandoned rows', async () => {
    const r = ledger(); r.nextCounter = MAX_ADMISSION_INTENTS.toString()
    r.entries = Array.from({ length: MAX_ADMISSION_INTENTS }, (_, i) => ({ ...owner, operation: hex(i + 100), challenge: hex(i + 2000), counter: i.toString(), createdAt: 100, deadline: 150, state: 'abandoned', request: null }))
    const m = memory(r), before = m.bytes()
    expect((await readAdmissionIntentLedger(m.tx, n)).entries).toHaveLength(1024)
    await expect(reserveAdmissionIntent(m.tx, n, owner, 100, 150)).rejects.toMatchObject(held('capacity')); expect(m.bytes()).toEqual(before); expect(m.writes()).toBe(0)
  })
  it('rejects oversized and noncanonical authenticated bytes before mutation', async () => {
    for (const bytes of [new Uint8Array(MAX_ADMISSION_INTENT_BYTES + 1).fill(32), new TextEncoder().encode(JSON.stringify(ledger()) + ' ')]) {
      const m = memory(); m.tx.readVault = async () => bytes
      await expect(readAdmissionIntentLedger(m.tx, n)).rejects.toBeInstanceOf(InvalidPersonaRecord)
      expect(bytes.every(x => x === 0)).toBe(true); expect(m.writes()).toBe(0)
    }
  })
})
