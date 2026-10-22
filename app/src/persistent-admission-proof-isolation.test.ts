import { describe, expect, it } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { PERSISTENT_PROOF_V2_PREFIX, PERSISTENT_TAB_PROOF_V2_PREFIX, inspectPersistentAdmissionProofs, proofsStillNameActor } from './persistent-admission-proof.js'

const H = 'a'.repeat(64), J = 'b'.repeat(64), K = 'c'.repeat(64)
const proofRow = (account: string, invitation: string, purpose: string) => `kithmoot.account.${account}.${PERSISTENT_PROOF_V2_PREFIX}${invitation}.${purpose}`

describe('reading the stored invitation proofs', () => {
  it('holds on a proof this copy cannot read unless the caller says it is only loading', () => {
    const browser = memoryDeviceStore()
    browser.set(proofRow(H, J, K), 'not even json')
    expect(() => inspectPersistentAdmissionProofs(browser, memoryDeviceStore())).toThrow(OrdinaryStateHold)
    expect(() => inspectPersistentAdmissionProofs(browser, memoryDeviceStore(), { isolateUnreadable: false })).toThrow(OrdinaryStateHold)
  })

  it('skips a proof this copy cannot read when only loading, says which, and does not hold every room', () => {
    // What an older copy meets when a newer one kept evidence carrying a key it does not know: the row will not verify here.
    const browser = memoryDeviceStore()
    browser.set(proofRow(H, J, K), JSON.stringify({ domain: 'kithmoot/persistent-admission-proof/v2', version: 2, binding: { operation: 'd'.repeat(64) }, evidence: { future: true } }))
    browser.set(proofRow(J, H, K), 'not even json')
    browser.set('kithmoot.name', 'Ada')
    const result = inspectPersistentAdmissionProofs(browser, memoryDeviceStore(), { isolateUnreadable: true })
    try {
      expect(result.proofs.size).toBe(0)
      expect(result.selected.size).toBe(0)
      expect(result.skipped).toEqual([
        { name: proofRow(H, J, K), why: 'unreadable' },
        { name: proofRow(J, H, K), why: 'unreadable' },
      ])
    } finally { result.close() }
  })

  it('reports nothing skipped when there is nothing stored, and ignores rows that are not proofs', () => {
    const browser = memoryDeviceStore()
    browser.set('kithmoot.name', 'Ada')
    const result = inspectPersistentAdmissionProofs(browser, memoryDeviceStore(), { isolateUnreadable: true })
    try { expect(result.skipped).toEqual([]) } finally { result.close() }
  })

  it('a tab record that is not a proof at all still holds: only a failure to read a proof is isolated', () => {
    const tab = memoryDeviceStore()
    tab.set(`kithmoot.account.${H}.${PERSISTENT_TAB_PROOF_V2_PREFIX}${J}`, '{"version":2}')
    expect(() => inspectPersistentAdmissionProofs(memoryDeviceStore(), tab, { isolateUnreadable: true })).toThrow(OrdinaryStateHold)
  })
})

describe('forgetting one invitation', () => {
  const mine = { participant: H, roomId: J }

  it('keeps the room’s device records while another readable proof names the same actor and room', () => {
    expect(proofsStillNameActor({ ...mine, skipped: 0, readable: [{ participant: H, roomId: J }] })).toBe(true)
  })

  it('deletes them when nothing else names them', () => {
    expect(proofsStillNameActor({ ...mine, skipped: 0, readable: [] })).toBe(false)
    expect(proofsStillNameActor({ ...mine, skipped: 0, readable: [{ participant: K, roomId: J }, { participant: H, roomId: K }] })).toBe(false)
  })

  it('keeps them while a proof this copy could not read is left over: nobody can say it does not depend on them', () => {
    expect(proofsStillNameActor({ ...mine, skipped: 1, readable: [] })).toBe(true)
    expect(proofsStillNameActor({ ...mine, skipped: 2, readable: [{ participant: K, roomId: K }] })).toBe(true)
  })
})
