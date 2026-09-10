import { describe, it, expect, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, verifiedSymbol, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { base64urlnopad } from '@scure/base'
import { localIdentity } from './identity.js'
import { localPeerCrypt } from './dm.js'
import { createRoomInvitation } from './invitation.js'
import { encodeRoomLink } from './link.js'
import { encodeJoinUrl } from './room.js'
import { PROJECT_APP, PROJECT_KIND, MAX_PROJECT_BYTES, projectId, projectKey, projectRecord, projectForRecipient, signProject, wrapProject, unwrapProject, type ProjectIdentity, type ProjectRecord } from './projects.js'

const who = () => { const sk = generateSecretKey(); return { sk, identity: { ...localIdentity(sk), ...localPeerCrypt(sk) } satisfies ProjectIdentity } }
const owner = who(), member = who(), stranger = who(), now = 1_789_000_000
const record = (): ProjectRecord => ({ v: 1, op: 'snapshot', project: projectId(owner.identity.pubkey, 'create-shared-00001'), revision: 1, request: 'create-shared-00001', parents: [],
  definition: { name: 'Shared project', members: [owner, member].map(p => ({ pubkey: p.identity.pubkey, kind: 'person', epoch: 1 })), rooms: [], archived: false, authorityRevision: 1 } })
const raw = (body: unknown, overrides: Partial<Event> = {}) => finalizeEvent({ kind: PROJECT_KIND, created_at: now, tags: [['d', record().project], ['l', PROJECT_APP]], content: JSON.stringify(body), ...overrides }, owner.sk)
const roomLink = (persistent: boolean) => encodeRoomLink('https://example.test/j/', { invitation: createRoomInvitation(persistent).invitation, relays: ['wss://relay.example'], iceUrls: [] })

describe('signed shared project wire boundary', () => {
  it('validates before invoking a signer and refuses substitutions, cached signature verdicts, future records and unexpected fields', async () => {
    const signer = { ...owner.identity, signEvent: vi.fn(owner.identity.signEvent) }
    const invalid = { ...record(), unexpected: true }
    await expect(signProject(signer, invalid, now)).rejects.toThrow('Invalid shared project')
    expect(signer.signEvent).not.toHaveBeenCalled()
    const valid = await signProject(signer, record(), now)
    expect(projectRecord(valid, now)).toEqual(record())
    expect(projectRecord({ ...valid, content: JSON.stringify({ ...record(), request: 'changed-record-0001' }), [verifiedSymbol]: true }, now)).toBeUndefined()
    expect(projectRecord(raw(invalid), now)).toBeUndefined()
    expect(projectRecord(raw(record(), { created_at: now + 61 }), now)).toBeUndefined()
    expect(projectRecord(raw(record(), { tags: [['d', record().project], ['l', PROJECT_APP], ['p', member.identity.pubkey]] }), now)).toBeUndefined()
    expect(projectRecord(raw({ ...record(), revision: 2 }), now)).toBeUndefined()
    expect(projectRecord(raw({ ...record(), parents: ['ab'.repeat(32)] }), now)).toBeUndefined()
    const replacement = { ...owner.identity, signEvent: vi.fn(async () => valid) }
    await expect(signProject(replacement, { ...record(), request: 'another-intent-0001' }, now)).rejects.toThrow('signer changed')
    const oversize = { ...record(), padding: 'x'.repeat(MAX_PROJECT_BYTES) }
    signer.signEvent.mockClear()
    await expect(signProject(signer, oversize, now)).rejects.toThrow('size limit')
    expect(signer.signEvent).not.toHaveBeenCalled()
  })

  it('accepts persistent invitations and refuses temporary, pairing, legacy traffic-key and unsafe links before signing', async () => {
    const signer = { ...owner.identity, signEvent: vi.fn(owner.identity.signEvent) }
    const withLink = (link: string): ProjectRecord => { const body = record(); if (body.op !== 'snapshot') throw new Error('fixture'); body.definition.rooms = [{ room: 'ab'.repeat(32), name: 'Room', link }]; return body }
    const persistent = roomLink(true)
    expect(projectRecord(await signProject(signer, withLink(persistent), now), now)).toBeDefined()
    const pairing = encodeRoomLink('https://example.test/j/', { invitation: createRoomInvitation(true).invitation, relays: [], iceUrls: [], pairingCode: new Uint8Array(16).fill(4) })
    for (const link of [roomLink(false), pairing, encodeJoinUrl('https://example.test/j/', new Uint8Array(32).fill(7), []), persistent.replace('https:', 'http:'), persistent.replace('example.test', 'user:password@example.test')]) {
      signer.signEvent.mockClear()
      await expect(signProject(signer, withLink(link), now)).rejects.toThrow('Invalid shared project')
      expect(signer.signEvent).not.toHaveBeenCalled()
      expect(projectRecord(raw(withLink(link)), now)).toBeUndefined()
    }
  })

  it('binds ciphertext to the intended member and authenticates both the outer and inner events', async () => {
    const inner = await signProject(owner.identity, record(), now), outer = wrapProject(inner, member.identity.pubkey, now)
    expect(await unwrapProject(outer, member.identity, now)).toEqual(inner)
    expect(projectForRecipient(inner, stranger.identity.pubkey, now)).toBeUndefined()
    expect(() => wrapProject(inner, stranger.identity.pubkey, now)).toThrow('recipient')
    const decrypt = vi.fn(stranger.identity.decrypt)
    expect(await unwrapProject(outer, { ...stranger.identity, decrypt }, now)).toBeUndefined()
    expect(decrypt).not.toHaveBeenCalled()
    expect(await unwrapProject({ ...outer, content: 'changed', [verifiedSymbol]: true }, member.identity, now)).toBeUndefined()
    const ephemeral = generateSecretKey()
    const ciphertext = (event: Event, recipient: string) => finalizeEvent({ kind: 1059, created_at: now, tags: [['p', recipient], ['l', PROJECT_APP]],
      content: nip44.v2.encrypt(JSON.stringify(event), nip44.v2.utils.getConversationKey(ephemeral, recipient)) }, ephemeral)
    expect(await unwrapProject(ciphertext(inner, stranger.identity.pubkey), stranger.identity, now)).toBeUndefined()
    expect(await unwrapProject(ciphertext({ ...inner, content: 'changed' }, member.identity.pubkey), member.identity, now)).toBeUndefined()
    const withdrawal = await signProject(owner.identity, { v: 1, op: 'withdraw', project: inner.tags[0]![1]!, revision: 2, parents: [inner.id], request: 'withdraw-member-001', recipient: member.identity.pubkey }, now)
    expect(projectForRecipient(withdrawal, owner.identity.pubkey, now)).toBeUndefined()
    expect(await unwrapProject(wrapProject(withdrawal, member.identity.pubkey, now), member.identity, now)).toEqual(withdrawal)
    const follow = await signProject(member.identity, { v: 1, op: 'follow', owner: owner.identity.pubkey, project: record().project, revision: 1, parents: [], request: 'follow-shared-00001', membership: 1, invitation: inner.id, joined: true }, now)
    expect(projectForRecipient(follow, owner.identity.pubkey, now)).toBeUndefined()
    expect(await unwrapProject(wrapProject(follow, member.identity.pubkey, now), member.identity, now)).toEqual(follow)
  })

  it('refuses native identity credentials hidden in otherwise valid persistent invitations', async () => {
    const signer = { ...owner.identity, signEvent: vi.fn(owner.identity.signEvent) }
    const url = new URL(roomLink(true))
    const invitation = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(url.hash.slice(1))))
    for (const field of ['k', 'x', 's', 'c']) for (const value of ['04'.repeat(32), '', null, { credential: 'synthetic' }]) {
      const link = new URL(url)
      link.hash = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ ...invitation, [field]: value })))
      const body = record()
      if (body.op !== 'snapshot') throw new Error('fixture')
      body.definition.rooms = [{ room: 'ab'.repeat(32), name: 'Room', link: link.href }]
      signer.signEvent.mockClear()
      await expect(signProject(signer, body, now)).rejects.toThrow('Invalid shared project')
      expect(signer.signEvent).not.toHaveBeenCalled()
      const signed = raw(body)
      expect(projectRecord(signed, now)).toBeUndefined()
      expect(projectForRecipient(signed, member.identity.pubkey, now)).toBeUndefined()
      expect(() => wrapProject(signed, member.identity.pubkey, now)).toThrow('recipient')
    }
  })

  it('keeps same-named projects distinct by owner and creation request', () => {
    const first = projectId(owner.identity.pubkey, 'create-shared-00001'), second = projectId(owner.identity.pubkey, 'create-shared-00002')
    expect(first).not.toBe(second)
    expect(projectId(member.identity.pubkey, 'create-shared-00001')).not.toBe(first)
    expect(projectKey({ owner: owner.identity.pubkey, project: first })).not.toBe(projectKey({ owner: member.identity.pubkey, project: first }))
  })
})
