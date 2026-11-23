import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { ORDINARY_SIGNET_KEYS as keys } from './ordinary-signet-snapshot.js'
import { personaConnection, PersonaSessionStorage, PersonaStore } from './persona-store.js'
import type { EncryptedRendezvousRecord, RendezvousVaultStorage } from './rendezvous-vault.js'

const origin = 'https://kithmoot.example'

function memoryVault() {
  let key: CryptoKey | undefined
  let record: EncryptedRendezvousRecord | undefined
  return {
    withLock: async <T>(work: () => Promise<T>) => work(),
    key: async () => key,
    saveKey: async (value: CryptoKey) => { key = value },
    record: async () => record,
    put: async (value: EncryptedRendezvousRecord) => { record = value },
    remove: async () => { record = undefined },
    erase: async () => { key = record = undefined },
  } satisfies RendezvousVaultStorage
}

function approvedPersona(label: string) {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const proof = finalizeEvent({ kind: 21236, content: '', created_at: 1024,
    tags: [['origin', origin], ['challenge', 'a'.repeat(64)], ['app', 'KithMoot']] }, secret)
  const storage = new PersonaSessionStorage({
    [keys.pubkey]: pubkey, [keys.authEvent]: JSON.stringify(proof), [keys.method]: 'nip07',
  })
  return personaConnection(storage, pubkey, label, origin)!
}

describe('saved signer personas', () => {
  it('reopens both approved connections with the selected persona after a restart', async () => {
    const work = approvedPersona('Work')
    const personal = approvedPersona('Personal')
    const storage = memoryVault()
    await new PersonaStore(origin, storage).add(personal, work)

    const restarted = new PersonaStore(origin, storage)
    expect(await restarted.selection()).toEqual({ active: personal.pubkey, personas: [
      { pubkey: personal.pubkey, label: 'Personal', method: 'nip07' },
      { pubkey: work.pubkey, label: 'Work', method: 'nip07' },
    ] })
    expect(await restarted.connection(work.pubkey)).toEqual(work)
    expect((await storage.key())?.extractable).toBe(false)
    expect(new TextDecoder().decode((await storage.record())?.ciphertext)).not.toContain(work.pubkey)
    await restarted.erase()
    expect(await storage.key()).toBeUndefined()
    expect(await restarted.selection()).toBeUndefined()
  })

  it('refuses a stale reconnect after a tab disconnects that persona', async () => {
    const work = approvedPersona('Work')
    const personal = approvedPersona('Personal')
    const storage = memoryVault()
    const store = new PersonaStore(origin, storage)
    await store.add(personal, work)
    const otherTab = new PersonaStore(origin, storage)
    await otherTab.disconnect(work.pubkey)
    await expect(store.select(work, work)).rejects.toThrow('signer connection changed')
    expect(await store.connection(work.pubkey)).toBeUndefined()
    expect((await store.selection())?.active).toBe(personal.pubkey)
  })

  it('refuses an approval when the stored proof is for a different identity', async () => {
    const work = approvedPersona('Work')
    const personal = approvedPersona('Personal')
    const store = new PersonaStore(origin, memoryVault())
    await store.add(work)
    await expect(store.add({ ...personal, session: work.session })).rejects.toThrow()
    expect((await store.selection())?.active).toBe(work.pubkey)
  })
})
