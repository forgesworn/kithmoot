import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure'
import { createDeviceCredential } from '../../src/credential.js'
import { bindingDigest } from '../../src/vmls/binding.js'
import { encodeUnsignedBinding } from '../../test/vmls-encode.js'
import {
  base64Encode, localLocks, MAX_JOURNAL_RECORDS, MlsVault, SIGN_METHOD,
  type ConsentScope, type MlsVaultStorage, type SealedRecord, type SignLeafBindingRequest, type VaultContext,
} from './mls-vault.js'
import { StoredRendezvousChild } from './rendezvous-vault.js'

const NOW = 1_793_577_600
const PRINCIPAL = 'https://kithmoot.forgesworn.dev'

class MemoryStorage implements MlsVaultStorage {
  epoch = 0
  revision() { return this.epoch ? String(this.epoch) : '' }
  invalidate() { this.epoch++ }
  stored: { seal: CryptoKey; name: CryptoKey } | undefined
  records = new Map<string, SealedRecord>()
  async keys() { return this.stored }
  async saveKeys(keys: { seal: CryptoKey; name: CryptoKey }) { this.stored = keys }
  async get(name: string) { return this.records.get(name) }
  async put(record: SealedRecord) { this.records.set(record.name, record) }
  async remove(name: string) { this.records.delete(name) }
}

/** An identity signer that remembers the credentials it signed. */
function signer(secret = generateSecretKey()) {
  const signed: Event[] = []
  return {
    secret,
    signed,
    pubkey: getPublicKey(secret),
    async signEvent(event: EventTemplate) { const e = finalizeEvent(event, secret); signed.push(e); return e },
  }
}

let clock = NOW
let storage: MemoryStorage
let vault: MlsVault
let alice: ReturnType<typeof signer>
let ctx: VaultContext
let device: string
let credential: Event
const homeBox = bytesToHex(randomBytes(32))
const approve = async () => 'approve' as const
const deny = async () => 'deny' as const

function request(over: Partial<{ credential: Event; device: string; homeBox: string; expiresAt: number; operation: string; deadline: number }> = {}): SignLeafBindingRequest {
  const body = encodeUnsignedBinding({
    leafId: randomBytes(32),
    signatureKey: randomBytes(32),
    credential: over.credential ?? credential,
    device: over.device ?? device,
    expiresAt: over.expiresAt ?? NOW + 86_400,
    homeBox: hexToBytes(over.homeBox ?? homeBox),
  })
  return {
    v: 1,
    operation: over.operation ?? bytesToHex(randomBytes(32)),
    body: base64Encode(body),
    digest: bytesToHex(bindingDigest(body)),
    expires_at: over.deadline ?? NOW + 300,
  }
}

const scopeFor = (box = homeBox): ConsentScope => ({ principal: PRINCIPAL, persona: alice.pubkey, device, homeBox: box, method: SIGN_METHOD })

beforeEach(async () => {
  clock = NOW
  storage = new MemoryStorage()
  vault = new MlsVault(storage, { crypto: webcrypto as unknown as Crypto, locks: localLocks(), now: () => clock })
  alice = signer()
  ctx = vault.context(PRINCIPAL, alice.pubkey)
  const enrolled = await vault.enrol(ctx, alice, NOW + 7 * 86_400)
  if (!enrolled.ok) throw new Error(enrolled.refusal)
  device = enrolled.value.device
  credential = alice.signed[0]!
})

describe('enrolment and storage', () => {
  it('enrols a device under a person credential and seals it without plaintext', async () => {
    expect(credential.tags).toContainEqual(['scope', 'person'])
    expect(credential.tags).toContainEqual(['device', device])
    expect(storage.stored?.seal.extractable).toBe(false)
    expect(storage.stored?.name.extractable).toBe(false)
    const raw = JSON.stringify([...storage.records.entries()].map(([name, r]) => [name, Buffer.from(r.ciphertext).toString('hex')]))
    expect(raw).not.toContain(alice.pubkey)
    expect(raw).not.toContain(device)
    expect(await vault.device(ctx)).toMatchObject({ ok: true, value: { device, persona: alice.pubkey } })
  })

  it('replaces an enrolled device only when asked to', async () => {
    expect(await vault.enrol(ctx, alice, NOW + 3600)).toEqual({ ok: false, refusal: 'unauthorised' })
    const replaced = await vault.enrol(ctx, alice, NOW + 3600, { replace: true })
    expect(replaced.ok && replaced.value.device !== device).toBe(true)
  })

  it('does not overwrite a device enrolled while the identity signer was pending', async () => {
    const store = new MemoryStorage()
    const locks = localLocks()
    const first = new MlsVault(store, { crypto: webcrypto as unknown as Crypto, locks, now: () => NOW })
    const second = new MlsVault(store, { crypto: webcrypto as unknown as Crypto, locks, now: () => NOW })
    let arrived = 0
    let release!: () => void
    const both = new Promise<void>(resolve => { release = resolve })
    const identity = { pubkey: alice.pubkey, signEvent: async (event: EventTemplate) => {
      if (++arrived === 2) release()
      await both
      return alice.signEvent(event)
    } }
    const results = await Promise.all([first, second].map(v => v.enrol(v.context(PRINCIPAL, alice.pubkey), identity, NOW + 3600)))
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, refusal: 'unauthorised' }])
  })

  it('does not replace or clear records if the cross-tab signal cannot be written', async () => {
    const before = new Map(storage.records)
    storage.invalidate = () => { throw new Error('signal unavailable') }
    await expect(vault.enrol(ctx, alice, NOW + 3600, { replace: true })).rejects.toThrow('signal unavailable')
    await expect(vault.clear(alice.pubkey)).rejects.toThrow('signal unavailable')
    expect(storage.records).toEqual(before)
  })

  it('refuses enrolment for another persona than the signer', async () => {
    const bob = signer()
    expect(await vault.enrol(ctx, bob, NOW + 3600)).toEqual({ ok: false, refusal: 'unauthorised' })
  })

  it('fails closed on a corrupt record, never a fallback', async () => {
    for (const record of storage.records.values()) new Uint8Array(record.ciphertext)[0]! ^= 1
    await expect(vault.signLeafBindingV1(ctx, request(), approve)).rejects.toThrow(/could not be opened/)
  })
})

describe('signLeafBindingV1', () => {
  it('signs a checked body once consent is given, and the signature verifies', async () => {
    const req = request()
    const result = await vault.signLeafBindingV1(ctx, req, approve)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ v: 1, operation: req.operation, digest: req.digest, device })
    expect(schnorr.verify(hexToBytes(result.value.signature), hexToBytes(req.digest), hexToBytes(device))).toBe(true)
    expect(vault.acceptSignReply(req, result.value).ok).toBe(true)
  })

  it('replays an identical retry without asking again, and refuses a changed one', async () => {
    const req = request()
    const first = await vault.signLeafBindingV1(ctx, req, approve)
    let asked = 0
    const again = await vault.signLeafBindingV1(ctx, { ...req }, async () => { asked++; return 'approve' })
    expect(asked).toBe(0)
    expect(again.ok && first.ok && again.value.signature === first.value.signature).toBe(true)
    const changed = request({ operation: req.operation })
    expect(await vault.signLeafBindingV1(ctx, changed, approve)).toEqual({ ok: false, refusal: 'replay' })
  })

  it('S18: refuses a room credential used as a person credential, before asking', async () => {
    const room = await createDeviceCredential({ identity: alice, devicePubkey: device, expiresAt: NOW + 3600, roomId: 'a'.repeat(64), now: () => NOW }) as Event
    let asked = false
    const result = await vault.signLeafBindingV1(ctx, request({ credential: room }), async () => { asked = true; return 'approve' })
    expect(result).toEqual({ ok: false, refusal: 'unauthorised' })
    expect(asked).toBe(false)
  })

  it('S19: refuses another device key or another person', async () => {
    const other = bytesToHex(schnorr.getPublicKey(secp256k1.utils.randomSecretKey()))
    expect(await vault.signLeafBindingV1(ctx, request({ device: other }), approve)).toEqual({ ok: false, refusal: 'unauthorised' })
    const bob = signer()
    const bobs = await createDeviceCredential({ identity: bob, devicePubkey: device, expiresAt: NOW + 3600, scope: 'person', now: () => NOW }) as Event
    expect(await vault.signLeafBindingV1(ctx, request({ credential: bobs }), approve)).toEqual({ ok: false, refusal: 'unauthorised' })
  })

  it('S20: no generic digest: a mismatched digest, a signed binding, extra fields or another version', async () => {
    const req = request()
    expect(await vault.signLeafBindingV1(ctx, { ...req, digest: bytesToHex(randomBytes(32)) }, approve)).toEqual({ ok: false, refusal: 'malformed' })
    const signed = base64Encode(Uint8Array.from([0xa8, ...Buffer.from(req.body, 'base64').subarray(1), 0x08, 0x58, 0x40, ...new Uint8Array(64)]))
    expect(await vault.signLeafBindingV1(ctx, { ...req, operation: bytesToHex(randomBytes(32)), body: signed }, approve)).toEqual({ ok: false, refusal: 'malformed' })
    expect(await vault.signLeafBindingV1(ctx, { ...req, extra: 1 }, approve)).toEqual({ ok: false, refusal: 'malformed' })
    expect(await vault.signLeafBindingV1(ctx, { ...req, v: 2 }, approve)).toEqual({ ok: false, refusal: 'unsupported' })
    expect(await vault.signLeafBindingV1(ctx, { ...req, body: req.body.replace(/=+$/, '') }, approve)).toEqual({ ok: false, refusal: 'malformed' })
  })

  it('bounds the operation deadline inclusively', async () => {
    expect((await vault.signLeafBindingV1(ctx, request({ deadline: NOW + 600 }), approve)).ok).toBe(true)
    expect(await vault.signLeafBindingV1(ctx, request({ deadline: NOW + 601 }), approve)).toEqual({ ok: false, refusal: 'malformed' })
    expect(await vault.signLeafBindingV1(ctx, request({ deadline: NOW - 1 }), approve)).toEqual({ ok: false, refusal: 'expired' })
  })

  it('S21: a new home box needs new consent; an approved scope is not asked again', async () => {
    await vault.approve(ctx, scopeFor())
    let asked = 0
    const prompt = async () => { asked++; return 'deny' as const }
    expect((await vault.signLeafBindingV1(ctx, request(), prompt)).ok).toBe(true)
    expect(asked).toBe(0)
    const elsewhere = bytesToHex(randomBytes(32))
    expect(await vault.signLeafBindingV1(ctx, request({ homeBox: elsewhere }), prompt)).toEqual({ ok: false, refusal: 'denied' })
    expect(asked).toBe(1)
    // A withdrawn approval asks again.
    await vault.withdraw(ctx, scopeFor())
    expect(await vault.signLeafBindingV1(ctx, request(), prompt)).toEqual({ ok: false, refusal: 'denied' })
    expect(asked).toBe(2)
  })

  it('S22: success, then revocation, then an identical retry is refused', async () => {
    const req = request()
    expect((await vault.signLeafBindingV1(ctx, req, approve)).ok).toBe(true)
    const id = (await vault.device(ctx))
    if (!id.ok) throw new Error('no device')
    await vault.revokeCredential(ctx, id.value.credentialId)
    expect(await vault.signLeafBindingV1(ctx, req, approve)).toEqual({ ok: false, refusal: 'revoked' })
  })

  it('S22: a cached success refuses once its deadline passes', async () => {
    const req = request()
    expect((await vault.signLeafBindingV1(ctx, req, approve)).ok).toBe(true)
    clock = req.expires_at + 1
    expect(await vault.signLeafBindingV1(ctx, req, approve)).toEqual({ ok: false, refusal: 'expired' })
  })

  it('S23: a denial stays denied on retry; a new operation can be approved', async () => {
    const req = request()
    expect(await vault.signLeafBindingV1(ctx, req, deny)).toEqual({ ok: false, refusal: 'denied' })
    let asked = false
    expect(await vault.signLeafBindingV1(ctx, req, async () => { asked = true; return 'approve' })).toEqual({ ok: false, refusal: 'denied' })
    expect(asked).toBe(false)
    expect((await vault.signLeafBindingV1(ctx, request(), approve)).ok).toBe(true)
  })

  it('S25 and E06: a persona switch during consent makes the operation and its replies stale', async () => {
    const before = request()
    const earlier = await vault.signLeafBindingV1(ctx, before, approve)
    // A new home box, so the prompt is asked; the switch happens during it.
    const result = await vault.signLeafBindingV1(ctx, request({ homeBox: bytesToHex(randomBytes(32)) }), async () => { vault.bump(); return 'approve' })
    expect(result).toEqual({ ok: false, refusal: 'stale' })
    expect(earlier.ok && vault.acceptSignReply(before, earlier.value)).toEqual({ ok: false, refusal: 'stale' })
    expect(await vault.signLeafBindingV1(ctx, request(), approve)).toEqual({ ok: false, refusal: 'stale' })
    const fresh = vault.context(PRINCIPAL, alice.pubkey)
    expect((await vault.signLeafBindingV1(fresh, request(), approve)).ok).toBe(true)
    // A retry of the earlier operation from the new generation is stale,
    // not a replay of a signature made under the old one.
    expect(await vault.signLeafBindingV1(fresh, before, approve)).toEqual({ ok: false, refusal: 'stale' })
  })

  it('refuses a reply it did not make, or one for another request', async () => {
    const req = request()
    const result = await vault.signLeafBindingV1(ctx, req, approve)
    if (!result.ok) throw new Error(result.refusal)
    expect(vault.acceptSignReply(req, { ...result.value })).toEqual({ ok: false, refusal: 'unauthorised' })
    expect(vault.acceptSignReply(request(), result.value)).toEqual({ ok: false, refusal: 'replay' })
  })

  it('caps live journal records at 1,024 with busy, never evicting', async () => {
    await vault.approve(ctx, scopeFor())
    for (let i = 0; i < MAX_JOURNAL_RECORDS; i++) {
      const result = await vault.signLeafBindingV1(ctx, request(), approve)
      if (!result.ok) throw new Error(`record ${i}: ${result.refusal}`)
    }
    expect(await vault.signLeafBindingV1(ctx, request(), approve)).toEqual({ ok: false, refusal: 'busy' })
    clock = NOW + 301
    expect((await vault.signLeafBindingV1(ctx, request({ deadline: NOW + 600 }), approve)).ok).toBe(true)
  }, 120_000)
})

describe('rendezvousEcdhV1', () => {
  const rzSecret = secp256k1.utils.randomSecretKey()
  const ownRz = getPublicKey(rzSecret)
  const peerSecret = secp256k1.utils.randomSecretKey()
  const peerRz = getPublicKey(peerSecret)
  const child = (identity: string) => async () => new StoredRendezvousChild({ identity, device: 'b'.repeat(64), rendezvousPubkey: ownRz, index: 1, expiresAt: NOW + 3600 }, rzSecret)
  const ecdh = (over: Partial<{ peer: string; deadline: number }> = {}) => ({ v: 1 as const, operation: bytesToHex(randomBytes(32)), peer_rz: over.peer ?? peerRz, expires_at: over.deadline ?? NOW + 300 })

  it('computes the shared x-coordinate with the provisioned child', async () => {
    const req = ecdh()
    const result = await vault.rendezvousEcdhV1(ctx, req, child(alice.pubkey))
    if (!result.ok) throw new Error(result.refusal)
    const expected = bytesToHex(secp256k1.getSharedSecret(peerSecret, hexToBytes('02' + ownRz)).slice(1))
    expect(result.value).toEqual({ v: 1, operation: req.operation, peer_rz: peerRz, own_rz: ownRz, shared_x: expected })
    expect(vault.acceptEcdhReply(req, result.value).ok).toBe(true)
  })

  it('E04: only a reply this vault made is accepted, so no substituted value gets through', async () => {
    const req = ecdh()
    const result = await vault.rendezvousEcdhV1(ctx, req, child(alice.pubkey))
    if (!result.ok) throw new Error(result.refusal)
    // The defence is the vault's own brand on the reply object, not any
    // check of `shared_x`: a forged value, and even a copy carrying the
    // right value, are both refused.
    expect(vault.acceptEcdhReply(req, { ...result.value, shared_x: bytesToHex(randomBytes(32)) })).toEqual({ ok: false, refusal: 'unauthorised' })
    expect(vault.acceptEcdhReply(req, { ...result.value })).toEqual({ ok: false, refusal: 'unauthorised' })
    // And the branded reply cannot be altered in place.
    expect(Object.isFrozen(result.value)).toBe(true)
    expect(() => { (result.value as { shared_x: string }).shared_x = '00'.repeat(32) }).toThrow(TypeError)
    expect(vault.acceptEcdhReply(req, result.value).ok).toBe(true)
  })

  it('E05: a reply for another peer, an off-curve peer, or another account is refused', async () => {
    const req = ecdh()
    const result = await vault.rendezvousEcdhV1(ctx, req, child(alice.pubkey))
    if (!result.ok) throw new Error(result.refusal)
    const other = getPublicKey(secp256k1.utils.randomSecretKey())
    expect(vault.acceptEcdhReply({ ...req, peer_rz: other }, result.value)).toEqual({ ok: false, refusal: 'replay' })
    expect(await vault.rendezvousEcdhV1(ctx, ecdh({ peer: 'f'.repeat(64) }), child(alice.pubkey))).toEqual({ ok: false, refusal: 'malformed' })
    expect(await vault.rendezvousEcdhV1(ctx, ecdh(), child(signer().pubkey))).toEqual({ ok: false, refusal: 'unauthorised' })
    expect(await vault.rendezvousEcdhV1(ctx, ecdh({ peer: ownRz }), child(alice.pubkey))).toEqual({ ok: false, refusal: 'malformed' })
  })

  it('E06: a cross-tab revision change fences ECDH replies', async () => {
    const req = ecdh()
    const result = await vault.rendezvousEcdhV1(ctx, req, child(alice.pubkey))
    if (!result.ok) throw new Error(result.refusal)
    storage.invalidate()
    expect(vault.acceptEcdhReply(req, result.value)).toEqual({ ok: false, refusal: 'stale' })
    expect(await vault.rendezvousEcdhV1(ctx, req, child(alice.pubkey))).toEqual({ ok: false, refusal: 'stale' })
  })

  it('E06: a reply from a previous vault generation is stale', async () => {
    const req = ecdh()
    const result = await vault.rendezvousEcdhV1(ctx, req, child(alice.pubkey))
    if (!result.ok) throw new Error(result.refusal)
    vault.bump()
    expect(vault.acceptEcdhReply(req, result.value)).toEqual({ ok: false, refusal: 'stale' })
  })
})

describe('device replacement fencing', () => {
  for (const change of ['clear', 'replace'] as const) {
    for (const decision of ['approve', 'deny'] as const) {
      it(`re-reads the device under the lock after ${change}, even without the invalidation signal (${decision})`, async () => {
        // Defence in depth: deliberately suppress the cross-tab signal.
        storage.invalidate = () => undefined
        const other = new MlsVault(storage, { crypto: webcrypto as unknown as Crypto, locks: localLocks(), now: () => NOW })
        const result = await vault.signLeafBindingV1(ctx, request(), async () => {
          if (change === 'clear') await other.clear(alice.pubkey)
          else expect((await other.enrol(other.context(PRINCIPAL, alice.pubkey), alice, NOW + 3600, { replace: true })).ok).toBe(true)
          return decision
        })
        expect(result).toEqual({ ok: false, refusal: 'stale' })
        // Clear leaves only the installation, replacement only that and device.
        expect(storage.records.size).toBe(change === 'clear' ? 1 : 2)
      })
    }
  }

  it('replacement invalidates the old context and returned signature in the same instance', async () => {
    const req = request()
    const signed = await vault.signLeafBindingV1(ctx, req, approve)
    if (!signed.ok) throw new Error(signed.refusal)
    expect((await vault.enrol(ctx, alice, NOW + 3600, { replace: true })).ok).toBe(true)
    expect(await vault.device(ctx)).toEqual({ ok: false, refusal: 'stale' })
    expect(vault.acceptSignReply(req, signed.value)).toEqual({ ok: false, refusal: 'stale' })
    expect((await vault.device(vault.context(PRINCIPAL, alice.pubkey))).ok).toBe(true)
  })
})

describe('the app generation', () => {
  it('follows the app account generation as well as its own bumps', async () => {
    let app = 3
    const v = new MlsVault(new MemoryStorage(), { crypto: webcrypto as unknown as Crypto, locks: localLocks(), now: () => NOW, generation: () => app })
    const c = v.context(PRINCIPAL, alice.pubkey)
    const enrolled = await v.enrol(c, alice, NOW + 3600)
    expect(enrolled.ok).toBe(true)
    app++
    expect(await v.device(c)).toEqual({ ok: false, refusal: 'stale' })
    expect((await v.device(v.context(PRINCIPAL, alice.pubkey))).ok).toBe(true)
  })
})
