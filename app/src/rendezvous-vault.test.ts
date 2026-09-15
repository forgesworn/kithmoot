import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { getPublicKey } from 'nostr-tools/pure'
import { base64urlnopad } from '@scure/base'
import {
  RendezvousVault,
  type EncryptedRendezvousRecord,
  type RendezvousVaultStorage,
} from './rendezvous-vault.js'

const NOW = 1_793_577_600
const identitySecret = new Uint8Array(32).fill(1)
const deviceSecret = new Uint8Array(32).fill(2)
const identity = getPublicKey(identitySecret)
const device = getPublicKey(deviceSecret)
const nonce = new Uint8Array(16).map((_, index) => index)

class MemoryStorage implements RendezvousVaultStorage {
  storedKey: CryptoKey | undefined
  value: EncryptedRendezvousRecord | undefined
  async key(): Promise<CryptoKey | undefined> { return this.storedKey }
  async saveKey(key: CryptoKey): Promise<void> { this.storedKey = key }
  async record(): Promise<EncryptedRendezvousRecord | undefined> { return this.value }
  async put(record: EncryptedRendezvousRecord): Promise<void> { this.value = record }
  async remove(): Promise<void> { this.value = undefined }
}

const expectRecord = { identity, device, nonce, now: NOW }
const deviceCrypt = { decrypt: async (peer: string, ciphertext: string) => decrypt(ciphertext, getConversationKey(deviceSecret, peer)) }

function response(index: number, scalar: Uint8Array): string {
  const rendezvous = getPublicKey(scalar)
  const record = JSON.stringify({
    v: 1, p: identity, d: device, rz: rendezvous, u: 'rendezvous', i: index,
    n: base64urlnopad.encode(nonce), e: NOW + 300, k: base64urlnopad.encode(scalar),
  })
  const ciphertext = encrypt(record, getConversationKey(scalar, device))
  return JSON.stringify({
    v: 1, p: identity, d: device, rz: rendezvous, u: 'rendezvous', i: index,
    n: base64urlnopad.encode(nonce), e: NOW + 300, c: ciphertext,
  })
}

describe('encrypted rendezvous vault', () => {
  it('accepts only the bound encrypted reply and never writes its scalar into ordinary storage', async () => {
    const storage = new MemoryStorage()
    const vault = new RendezvousVault(storage, webcrypto as unknown as Crypto)
    const scalar = new Uint8Array(32).fill(3)
    await expect(vault.accept(response(7, scalar), expectRecord, deviceCrypt)).resolves.toMatchObject({ ok: true, receipt: { index: 7 } })
    expect(storage.storedKey?.extractable).toBe(false)
    const persisted = JSON.stringify(storage.value)
    expect(persisted).not.toContain(Buffer.from(scalar).toString('hex'))
    expect(persisted).not.toContain(base64urlnopad.encode(scalar))
    const active = await vault.active(identity, device)
    expect(active?.receipt).toMatchObject({ identity, device, rendezvousPubkey: getPublicKey(scalar), index: 7 })
    expect(active?.withScalar(value => getPublicKey(value))).toBe(getPublicKey(scalar))
    active?.wipe()
  })

  it('refuses mismatched wrappers and only rotates to a newer index, then sign-out erases it', async () => {
    const storage = new MemoryStorage()
    const vault = new RendezvousVault(storage, webcrypto as unknown as Crypto)
    const first = new Uint8Array(32).fill(3), second = new Uint8Array(32).fill(4)
    const wrongOuter = response(7, first).replace(`"rz":"${getPublicKey(first)}"`, `"rz":"${getPublicKey(second)}"`)
    await expect(vault.accept(wrongOuter, expectRecord, deviceCrypt)).resolves.toEqual({ ok: false, reason: 'ciphertext' })
    await expect(vault.accept(response(7, first), expectRecord, deviceCrypt)).resolves.toMatchObject({ ok: true })
    await expect(vault.accept(response(7, first), expectRecord, deviceCrypt)).resolves.toEqual({ ok: false, reason: 'index' })
    await expect(vault.accept(response(8, second), expectRecord, deviceCrypt)).resolves.toMatchObject({ ok: true, receipt: { index: 8 } })
    await vault.clear(identity)
    await expect(vault.active(identity, device)).resolves.toBeUndefined()
    expect(storage.value).toBeUndefined()
  })

  it('fails closed on a corrupt encrypted record and never makes a replacement child', async () => {
    const storage = new MemoryStorage()
    const vault = new RendezvousVault(storage, webcrypto as unknown as Crypto)
    await vault.accept(response(7, new Uint8Array(32).fill(3)), expectRecord, deviceCrypt)
    storage.value = { ...storage.value!, ciphertext: storage.value!.ciphertext.slice(1) }
    await expect(vault.active(identity, device)).rejects.toThrow(/could not be opened/)
  })
})
