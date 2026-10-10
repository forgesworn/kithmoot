import { describe, expect, it, vi } from 'vitest'
import { nip44 } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, verifiedSymbol, type Event } from 'nostr-tools/pure'
import { localPeerCrypt } from './dm.js'
import { dmRelayListTemplate, KIND_RELAY_LIST } from './dm-relays.js'
import { localIdentity } from './identity.js'
import {
  VMLS_REVOCATION_GIFT_WRAP_KIND,
  VMLS_REVOCATION_REQUEST_KIND,
  VMLS_REVOCATION_REQUEST_LABEL,
  createVmlsRevocationRumor,
  parseVmlsRevocationRumor,
  sendVmlsRevocationRequest,
  unwrapVmlsRevocationRequest,
  vmlsMemberGrantReference,
  wrapVmlsRevocationRequest,
  type VmlsRevocationIdentity,
  type VmlsRevocationRequest,
} from './vmls-revocation-request.js'

const who = () => {
  const sk = generateSecretKey()
  return { sk, identity: { ...localIdentity(sk), ...localPeerCrypt(sk) } satisfies VmlsRevocationIdentity }
}
const member = who(), keeper = who(), other = who(), now = 1_900_000_000
const request = (): VmlsRevocationRequest => ({ sender: member.identity.pubkey, keeper: keeper.identity.pubkey, device: '33'.repeat(32),
  sessions: ['44'.repeat(32)], boxes: ['55'.repeat(32)], createdAt: now, expiration: now + 86_400 })

describe('VMLS member revocation request wire boundary', () => {
  it('builds and strictly parses the unsigned inner-only rumour', () => {
    const rumor = createVmlsRevocationRumor(request())
    expect(rumor).toMatchObject({ pubkey: member.identity.pubkey, kind: VMLS_REVOCATION_REQUEST_KIND, content: '' })
    expect(rumor).not.toHaveProperty('sig')
    expect(parseVmlsRevocationRumor(JSON.stringify(rumor), member.identity.pubkey, keeper.identity.pubkey, now)).toEqual(request())
    expect(rumor.tags).toEqual([['p', keeper.identity.pubkey], ['t', VMLS_REVOCATION_REQUEST_LABEL], ['device', '33'.repeat(32)],
      ['expiration', String(now + 86_400)], ['session', '44'.repeat(32)], ['box', '55'.repeat(32)]])
  })

  it('refuses ambiguous authority, hostile framing, stale and future requests', () => {
    const rumor = createVmlsRevocationRumor(request())
    const withTags = (tags: string[][]) => JSON.stringify({ ...rumor, tags, id: createVmlsRevocationRumor(request()).id })
    for (const invalid of [
      { ...request(), sender: keeper.identity.pubkey },
      { ...request(), sessions: [] },
      { ...request(), boxes: ['55'.repeat(32), '55'.repeat(32)] },
      { ...request(), expiration: now + 7 * 86_400 + 1 },
      { ...request(), unexpected: true },
    ]) expect(() => createVmlsRevocationRumor(invalid as VmlsRevocationRequest)).toThrow('Invalid')
    expect(() => parseVmlsRevocationRumor(JSON.stringify(rumor), other.identity.pubkey, keeper.identity.pubkey, now)).toThrow('Invalid')
    expect(() => parseVmlsRevocationRumor(withTags([...rumor.tags, ['p', keeper.identity.pubkey]]), member.identity.pubkey, keeper.identity.pubkey, now)).toThrow('Invalid')
    expect(() => parseVmlsRevocationRumor(JSON.stringify({ ...rumor, unexpected: true }), member.identity.pubkey, keeper.identity.pubkey, now)).toThrow('Invalid')
    expect(() => parseVmlsRevocationRumor(JSON.stringify(createVmlsRevocationRumor({ ...request(), createdAt: now + 601, expiration: now + 700 })), member.identity.pubkey, keeper.identity.pubkey, now)).toThrow('Invalid')
    expect(() => parseVmlsRevocationRumor(JSON.stringify(rumor), member.identity.pubkey, keeper.identity.pubkey, now + 86_400)).toThrow('Invalid')
    expect(() => parseVmlsRevocationRumor(' '.repeat(16_385), member.identity.pubkey, keeper.identity.pubkey, now)).toThrow('Invalid')
    for (let cut = 0; cut < JSON.stringify(rumor).length; cut++) expect(() => parseVmlsRevocationRumor(JSON.stringify(rumor).slice(0, cut), member.identity.pubkey, keeper.identity.pubkey, now)).toThrow()
  })

  it('round-trips a sealed gift wrap while exposing only the keeper outside', async () => {
    const wrapper = await wrapVmlsRevocationRequest(member.identity, request(), () => 0.5)
    expect(wrapper.kind).toBe(VMLS_REVOCATION_GIFT_WRAP_KIND)
    expect(wrapper.tags).toEqual([['p', keeper.identity.pubkey]])
    expect(wrapper.created_at).toBe(now - 86_400)
    expect(JSON.stringify(wrapper)).not.toContain(member.identity.pubkey)
    expect(JSON.stringify(wrapper)).not.toContain('33'.repeat(32))
    expect(await unwrapVmlsRevocationRequest(wrapper, keeper.identity, now)).toEqual(request())
    expect(await unwrapVmlsRevocationRequest(wrapper, other.identity, now)).toBeUndefined()
    expect(await unwrapVmlsRevocationRequest({ ...wrapper, content: `${wrapper.content}x`, [verifiedSymbol]: true }, keeper.identity, now)).toBeUndefined()
  })

  it('checks the identity signer result and the seal-to-rumour author binding', async () => {
    const good = await wrapVmlsRevocationRequest(member.identity, request(), () => 0)
    const changed = { ...member.identity, signEvent: vi.fn(async () => finalizeEvent({ kind: 13, created_at: now, tags: [], content: 'changed' }, member.sk)) }
    await expect(wrapVmlsRevocationRequest(changed, request(), () => 0)).rejects.toThrow('signer changed')
    const seal = JSON.parse(nip44.v2.decrypt(good.content, nip44.v2.utils.getConversationKey(keeper.sk, good.pubkey))) as Event
    const foreignRumor = JSON.stringify(createVmlsRevocationRumor({ ...request(), sender: other.identity.pubkey }))
    const forgedSeal = finalizeEvent({ kind: 13, created_at: seal.created_at, tags: [], content: await other.identity.encrypt(keeper.identity.pubkey, foreignRumor) }, member.sk)
    const ephemeral = generateSecretKey()
    const forged = finalizeEvent({ kind: 1059, created_at: now, tags: [['p', keeper.identity.pubkey]],
      content: nip44.v2.encrypt(JSON.stringify(forgedSeal), nip44.v2.utils.getConversationKey(ephemeral, keeper.identity.pubkey)) }, ephemeral)
    ephemeral.fill(0)
    expect(await unwrapVmlsRevocationRequest(forged, keeper.identity, now)).toBeUndefined()
  })

  it('derives the member-side grant reference from the exact box and device', () => {
    const reference = vmlsMemberGrantReference('55'.repeat(32), '33'.repeat(32))
    expect(reference).toMatch(/^[0-9a-f]{64}$/)
    expect(vmlsMemberGrantReference('55'.repeat(32), '34'.repeat(32))).not.toBe(reference)
    expect(vmlsMemberGrantReference('56'.repeat(32), '33'.repeat(32))).not.toBe(reference)
    expect(() => vmlsMemberGrantReference('55', '33'.repeat(32))).toThrow('Invalid')
  })

  it('publishes without identity AUTH only after a verified keeper kind-10050 list', async () => {
    const older = await keeper.identity.signEvent(dmRelayListTemplate(['wss://old.example'], now - 1))
    const latest = await keeper.identity.signEvent(dmRelayListTemplate(['wss://one.example', 'wss://two.example'], now))
    const publish = vi.fn(async () => undefined)
    const sent = await sendVmlsRevocationRequest({ identity: member.identity, request: request(), directoryEvents: [older, latest], publish, random: () => 0 })
    expect(sent.relays).toEqual(['wss://one.example/', 'wss://two.example/'])
    expect(sent.authenticate).toBe(false)
    expect(publish).toHaveBeenCalledOnce()
    expect(await unwrapVmlsRevocationRequest(sent.event, keeper.identity, now)).toEqual(request())
  })

  it('has no relay fallback, records no refused publish, and invalidates stale signer work', async () => {
    const nip65 = await keeper.identity.signEvent({ kind: KIND_RELAY_LIST, created_at: now, tags: [['r', 'wss://fallback.example']], content: '' })
    const publish = vi.fn(async () => undefined)
    await expect(sendVmlsRevocationRequest({ identity: member.identity, request: request(), directoryEvents: [nip65], publish })).rejects.toThrow('no DM relay list')
    expect(publish).not.toHaveBeenCalled()
    const list = await keeper.identity.signEvent(dmRelayListTemplate(['wss://one.example'], now))
    await expect(sendVmlsRevocationRequest({ identity: member.identity, request: request(), directoryEvents: [list],
      publish: async () => { throw new Error('relay refused') }, random: () => 0 })).rejects.toThrow('relay refused')
    let current = true
    const stale = { ...member.identity, signEvent: async (...args: Parameters<VmlsRevocationIdentity['signEvent']>) => {
      const signed = await member.identity.signEvent(...args); current = false; return signed
    } }
    await expect(sendVmlsRevocationRequest({ identity: stale, request: request(), directoryEvents: [list], publish, current: () => current, random: () => 0 })).rejects.toThrow('account changed')
    expect(publish).not.toHaveBeenCalled()
  })
})
