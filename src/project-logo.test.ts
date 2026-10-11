import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, verifiedSymbol, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { localIdentity } from './identity.js'
import { localPeerCrypt } from './dm.js'
import { createLogoImage } from './logo-image.js'
import { projectAuthority, projectId, signProject, projectRecord, PROJECT_KIND, PROJECT_WRAP_KIND, type ProjectIdentity } from './projects.js'
import { PROJECT_LOGO_APP, projectLogoRecord, signProjectLogo, unwrapProjectLogo, wrapProjectLogo, type ProjectLogoContext, type ProjectLogoRecord } from './project-logo.js'

const who = () => { const sk = generateSecretKey(); return { sk, identity: { ...localIdentity(sk), ...localPeerCrypt(sk) } satisfies ProjectIdentity } }
const owner = who(), member = who(), stranger = who(), now = 1_789_000_000
const context: ProjectLogoContext = { reference: { owner: owner.identity.pubkey, project: projectId(owner.identity.pubkey, 'logo-project-00001') },
  definition: { name: 'Shared project', members: [owner, member].map(person => ({ pubkey: person.identity.pubkey, kind: 'person', epoch: 1 })), rooms: [], archived: false, authorityRevision: 1 } }
const image = createLogoImage(new Uint8Array(readFileSync(new URL('../desktop/icons/kithmoot-128.png', import.meta.url))), 'image/png')
const record = (): ProjectLogoRecord => ({ v: 1, op: 'logo', project: context.reference.project,
  authority: projectAuthority(context.reference, context.definition), version: 1, request: 'change-logo-000001', image })
const raw = (body: unknown, overrides: Partial<Event> = {}, sk = owner.sk) => finalizeEvent({ kind: PROJECT_KIND, created_at: now,
  tags: [['d', `logo:${context.reference.project}`], ['l', PROJECT_LOGO_APP]], content: JSON.stringify(body), ...overrides }, sk)

describe('project logo companion records', () => {
  it('round-trips a signed encrypted image and explicit removal for only current members', async () => {
    const inner = await signProjectLogo(owner.identity, context, record(), now)
    expect(projectLogoRecord(inner, context, now)).toEqual(record())
    const outer = wrapProjectLogo(inner, member.identity.pubkey, context, now)
    expect(outer.content).not.toContain(image.data)
    expect(JSON.stringify(outer.tags)).not.toContain(context.reference.project)
    expect(await unwrapProjectLogo(outer, member.identity, context, now)).toEqual(inner)
    const cleared = await signProjectLogo(owner.identity, context, { ...record(), image: null, version: 2, request: 'remove-logo-000001' }, now)
    expect(projectLogoRecord(cleared, context, now)?.image).toBeNull()
    expect(await unwrapProjectLogo(wrapProjectLogo(cleared, member.identity.pubkey, context, now), member.identity, context, now)).toEqual(cleared)
  })
  it('does not change strict existing project records, membership or execution authority', async () => {
    const authority = projectAuthority(context.reference, context.definition)
    const directory = await signProject(owner.identity, { v: 1, op: 'snapshot', project: context.reference.project, revision: 1,
      request: 'create-directory-001', parents: [], definition: context.definition }, now)
    const logo = await signProjectLogo(owner.identity, context, record(), now)
    expect(projectRecord(directory, now)).toBeDefined()
    expect(projectRecord(logo, now)).toBeUndefined()
    expect(projectLogoRecord(directory, context, now)).toBeUndefined()
    expect(projectAuthority(context.reference, context.definition)).toBe(authority)
  })
  it('decrypts only once across verified current directory contexts and never for an empty directory', async () => {
    const inner = await signProjectLogo(owner.identity, context, record(), now)
    const outer = wrapProjectLogo(inner, member.identity.pubkey, context, now)
    const other = { ...context, reference: { ...context.reference, project: 'ab'.repeat(32) } }
    const decrypt = vi.fn(member.identity.decrypt), identity = { ...member.identity, decrypt }
    expect(await unwrapProjectLogo(outer, identity, [], now)).toBeUndefined()
    expect(decrypt).not.toHaveBeenCalled()
    expect(await unwrapProjectLogo(outer, identity, [other, context], now)).toEqual(inner)
    expect(decrypt).toHaveBeenCalledTimes(1)
  })
  it('rejects non-owner edits and invalid images before invoking a signer', async () => {
    const unauthorised = { ...member.identity, signEvent: vi.fn(member.identity.signEvent) }
    await expect(signProjectLogo(unauthorised, context, record(), now)).rejects.toThrow('owner')
    expect(unauthorised.signEvent).not.toHaveBeenCalled()
    const signer = { ...owner.identity, signEvent: vi.fn(owner.identity.signEvent) }
    await expect(signProjectLogo(signer, context, { ...record(), image: { ...image, data: 'https://tracker.invalid/logo.png' } }, now)).rejects.toThrow('Invalid')
    await expect(signProjectLogo(signer, context, { ...record(), version: 0 }, now)).rejects.toThrow('Invalid')
    expect(signer.signEvent).not.toHaveBeenCalled()
  })
  it('binds the logo to the exact owner, project and current membership authority', async () => {
    const inner = await signProjectLogo(owner.identity, context, record(), now)
    expect(projectLogoRecord(inner, { ...context, reference: { ...context.reference, project: 'ab'.repeat(32) } }, now)).toBeUndefined()
    expect(projectLogoRecord(raw(record(), {}, stranger.sk), context, now)).toBeUndefined()
    const changed = structuredClone(context)
    changed.definition.members[1]!.epoch = 2; changed.definition.authorityRevision = 2
    expect(projectLogoRecord(inner, changed, now)).toBeUndefined()
    const restored = structuredClone(changed); restored.definition.members[1]!.epoch = 3
    expect(projectLogoRecord(inner, restored, now)).toBeUndefined()
  })
  it('rejects altered signatures, future events, unexpected fields and signer substitutions', async () => {
    const inner = await signProjectLogo(owner.identity, context, record(), now)
    expect(projectLogoRecord({ ...inner, content: JSON.stringify({ ...record(), image: null }), [verifiedSymbol]: true }, context, now)).toBeUndefined()
    expect(projectLogoRecord(raw({ ...record(), unexpected: true }), context, now)).toBeUndefined()
    expect(projectLogoRecord(raw(record(), { created_at: now + 61 }), context, now)).toBeUndefined()
    expect(projectLogoRecord(raw(record(), { tags: [['d', context.reference.project], ['l', PROJECT_LOGO_APP]] }), context, now)).toBeUndefined()
    const signer = { ...owner.identity, signEvent: vi.fn(async () => inner) }
    await expect(signProjectLogo(signer, context, { ...record(), request: 'another-logo-00001' }, now)).rejects.toThrow('signer changed')
  })
  it('never decrypts for an unrelated recipient, invalid directory or altered outer envelope', async () => {
    const inner = await signProjectLogo(owner.identity, context, record(), now)
    expect(() => wrapProjectLogo(inner, stranger.identity.pubkey, context, now)).toThrow('recipient')
    const outer = wrapProjectLogo(inner, member.identity.pubkey, context, now)
    const decrypt = vi.fn(member.identity.decrypt)
    expect(await unwrapProjectLogo({ ...outer, content: 'changed', [verifiedSymbol]: true }, { ...member.identity, decrypt }, context, now)).toBeUndefined()
    expect(await unwrapProjectLogo(outer, { ...member.identity, decrypt }, { ...context, definition: { ...context.definition, name: '' } }, now)).toBeUndefined()
    expect(decrypt).not.toHaveBeenCalled()
    const strangerDecrypt = vi.fn(stranger.identity.decrypt)
    expect(await unwrapProjectLogo(outer, { ...stranger.identity, decrypt: strangerDecrypt }, context, now)).toBeUndefined()
    expect(strangerDecrypt).not.toHaveBeenCalled()
    const ephemeral = generateSecretKey()
    const forged = finalizeEvent({ kind: PROJECT_WRAP_KIND, created_at: now, tags: [['p', member.identity.pubkey], ['l', PROJECT_LOGO_APP]],
      content: nip44.v2.encrypt(JSON.stringify({ ...inner, content: JSON.stringify({ ...record(), image: null }) }), nip44.v2.utils.getConversationKey(ephemeral, member.identity.pubkey)) }, ephemeral)
    expect(await unwrapProjectLogo(forged, member.identity, context, now)).toBeUndefined()
  })
})
