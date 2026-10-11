import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, type Event } from 'nostr-tools/pure'
import { localIdentity } from './identity.js'
import { localPeerCrypt } from './dm.js'
import { createLogoImage } from './logo-image.js'
import { ProjectDirectory, type ProjectDirectoryStorage } from './project-directory.js'
import { projectAuthority, projectId, signProject, wrapProject, type ProjectDefinition, type ProjectIdentity } from './projects.js'
import { PROJECT_LOGO_APP, signProjectLogo, wrapProjectLogo } from './project-logo.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const who = (): ProjectIdentity => { const sk = generateSecretKey(); return { ...localIdentity(sk), ...localPeerCrypt(sk) } }
const definition = (...members: ProjectIdentity[]): ProjectDefinition => ({ name: 'Workshop', archived: false, authorityRevision: 1, rooms: [], members: members.map(person => ({ pubkey: person.pubkey, kind: 'person', epoch: 1 })) })
const image = createLogoImage(new Uint8Array(readFileSync(new URL('../desktop/icons/kithmoot-128.png', import.meta.url))), 'image/png')
function cache(): ProjectDirectoryStorage {
  let value: string | undefined
  return { async load() { return value }, async save(next) { value = next } }
}
class GuardedTransport extends SimTransport {
  async publishGuarded(event: Event, current: () => boolean): Promise<void> {
    if (!current()) throw new Error('Project authority changed')
    await this.publish(event)
  }
}
async function open(identity: ProjectIdentity, relay: SimRelay, storage = cache(), transport = new GuardedTransport(relay)) {
  const directory = new ProjectDirectory({ identity, transport, storage })
  await directory.open(); await vi.waitFor(() => expect(directory.snapshot().ready).toBe(true))
  return directory
}
async function synced(...directories: ProjectDirectory[]) {
  await vi.waitFor(() => { for (const directory of directories) expect(directory.snapshot().pendingSends).toBe(0) }, { timeout: 10_000 })
}

describe('project logo journal under the directory storage lock', () => {
  it('shares an inline image and removal, preserves directory authority, and recovers encrypted state without relay history', async () => {
    const relay = new SimRelay({ replay: true }), owner = who(), member = who(), stored = cache()
    const a = await open(owner, relay), b = await open(member, relay, stored)
    try {
      await a.create(definition(owner, member), 'create-logo-project-01'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects).toHaveLength(1))
      const project = a.snapshot().projects[0]!, authority = project.authority
      await a.updateLogo(project, project.heads, [], image, 'share-project-logo-01'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects[0]!.logo).toEqual(image))
      expect(b.snapshot().projects[0]!.joined).toBe(false)
      expect(a.snapshot().projects[0]!.authority).toBe(authority)
      expect(await stored.load()).not.toContain(image.data)
      await b.close()
      const restored = await open(member, new SimRelay(), stored)
      try {
        expect(restored.snapshot().projects[0]!.logo).toEqual(image)
        expect(restored.snapshot().projects[0]!.joined).toBe(false)
      } finally { await restored.close() }
      const latest = a.snapshot().projects[0]!
      await a.updateLogo(latest, latest.heads, latest.logoHeads!, null, 'remove-project-logo-01'); await synced(a)
      expect(a.snapshot().projects[0]!.logo).toBeNull()
    } finally { await a.close(); await b.close() }
  })

  it('restores exact offline envelopes and immutable request receipts without signing another logo', async () => {
    const relay = new SimRelay({ replay: true }), owner = who(), stored = cache(), transport = new GuardedTransport(relay)
    const a = await open(owner, relay, stored, transport)
    await a.create(definition(owner), 'create-offline-logo-01'); await synced(a)
    const project = a.snapshot().projects[0]!
    const publish = vi.spyOn(transport, 'publishGuarded').mockRejectedValue(new Error('offline'))
    const receipt = await a.updateLogo(project, project.heads, [], image, 'offline-logo-request-01')
    await vi.waitFor(() => expect(publish).toHaveBeenCalled())
    const original = structuredClone(publish.mock.calls[0]![0])
    await a.close()
    const signer = { ...owner, signEvent: vi.fn(owner.signEvent) }, retryTransport = new GuardedTransport(relay)
    const retried = vi.spyOn(retryTransport, 'publishGuarded'), restored = await open(signer, new SimRelay(), stored, retryTransport)
    try {
      expect(restored.snapshot().pendingSends).toBe(1)
      expect(await restored.updateLogo(project, project.heads, [], image, 'offline-logo-request-01')).toEqual(receipt)
      await synced(restored)
      expect(retried.mock.calls[0]![0]).toEqual(original)
      expect(signer.signEvent).not.toHaveBeenCalled()
      await expect(restored.updateLogo(project, project.heads, [], null, 'offline-logo-request-01')).rejects.toThrow('different project logo')
    } finally { await restored.close() }
  })

  it('withholds concurrent logo versions and requires every observed head to resolve them', async () => {
    const relay = new SimRelay({ replay: true }), owner = who(), a = await open(owner, relay)
    try {
      await a.create(definition(owner), 'create-conflict-logo-01'); await synced(a)
      const project = a.snapshot().projects[0]!, context = { reference: project, definition: project.definition! }
      const common = { v: 1 as const, op: 'logo' as const, project: project.project, authority: project.authority!, version: 1 }
      const left = await signProjectLogo(owner, context, { ...common, request: 'left-logo-conflict-01', image })
      const right = await signProjectLogo(owner, context, { ...common, request: 'right-logo-conflict-01', image: null })
      relay.publish(wrapProjectLogo(left, owner.pubkey, context)); relay.publish(wrapProjectLogo(right, owner.pubkey, context))
      await vi.waitFor(() => expect(a.snapshot().projects[0]!.logoConflicted).toBe(true))
      const conflicted = a.snapshot().projects[0]!
      expect(conflicted.logo).toBeUndefined(); expect(conflicted.authority).toBe(project.authority)
      await expect(a.updateLogo(conflicted, conflicted.heads, [left.id], image, 'bad-logo-resolution-01')).rejects.toThrow('Project or logo changed')
      await a.updateLogo(conflicted, conflicted.heads, conflicted.logoHeads!, image, 'resolve-logo-conflict-01'); await synced(a)
      expect(a.snapshot().projects[0]).toMatchObject({ logo: image, logoConflicted: false })
      relay.publish(wrapProjectLogo(right, owner.pubkey, context))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(a.snapshot().projects[0]!.logo).toEqual(image)
    } finally { await a.close() }
  })

  it('refreshes the logo for changed membership and archive/restore without reviving old authority', async () => {
    const relay = new SimRelay({ replay: true }), owner = who(), member = who(), newcomer = who()
    const a = await open(owner, relay), b = await open(member, relay), c = await open(newcomer, relay)
    try {
      await a.create(definition(owner, member), 'create-refresh-logo-01'); await synced(a)
      const initial = a.snapshot().projects[0]!
      await a.updateLogo(initial, initial.heads, [], image, 'initial-refresh-logo-01'); await synced(a)
      const branded = a.snapshot().projects[0]!, before = relay.published.filter(event => event.tags.some(tag => tag[0] === 'l' && tag[1] === PROJECT_LOGO_APP)).length
      await a.update(branded, branded.heads, definition(owner, newcomer), 'replace-logo-member-01'); await synced(a)
      await vi.waitFor(() => { expect(b.snapshot().projects[0]!.withdrawn).toBe(true); expect(c.snapshot().projects[0]!.logo).toEqual(image) })
      expect(b.snapshot().projects[0]!.logo).toBeUndefined()
      const changed = a.snapshot().projects[0]!
      expect(changed.authority).not.toBe(branded.authority)
      expect(changed.logoHeads).not.toEqual(branded.logoHeads)
      const delivered = relay.published.filter(event => event.tags.some(tag => tag[0] === 'l' && tag[1] === PROJECT_LOGO_APP)).slice(before)
      expect(delivered.every(event => event.tags[0]![1] !== member.pubkey)).toBe(true)
      await a.update(changed, changed.heads, { ...changed.definition!, archived: true }, 'archive-branded-project'); await synced(a)
      const archived = a.snapshot().projects[0]!
      expect(archived.logo).toBeUndefined()
      await a.update(archived, archived.heads, { ...archived.definition!, archived: false }, 'restore-branded-project'); await synced(a)
      expect(a.snapshot().projects[0]!.logo).toEqual(image)
      expect(a.snapshot().projects[0]!.authority).not.toBe(branded.authority)
    } finally { await a.close(); await b.close(); await c.close() }
  })

  it('holds a companion arriving before the project directory without decrypting or joining unknown membership', async () => {
    const relay = new SimRelay(), owner = who(), member = who(), decrypt = vi.fn(member.decrypt)
    const b = await open({ ...member, decrypt }, relay)
    try {
      const ref = { owner: owner.pubkey, project: projectId(owner.pubkey, 'create-out-of-order-01') }, body = definition(owner, member)
      const context = { reference: ref, definition: body }
      const logo = await signProjectLogo(owner, context, { v: 1, op: 'logo', project: ref.project, authority: projectAuthority(ref, body), version: 1, request: 'early-logo-request-01', image })
      relay.publish(wrapProjectLogo(logo, member.pubkey, context))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(decrypt).not.toHaveBeenCalled(); expect(b.snapshot().projects).toEqual([])
      const directory = await signProject(owner, { v: 1, op: 'snapshot', project: ref.project, revision: 1, parents: [], request: 'create-out-of-order-01', definition: body })
      relay.publish(wrapProject(directory, member.pubkey))
      await vi.waitFor(() => expect(b.snapshot().projects[0]!.logo).toEqual(image))
      expect(b.snapshot().projects[0]!.joined).toBe(false)
    } finally { await b.close() }
  })

  it('does not publish after a failed journal save or grant non-owners logo editing', async () => {
    const relay = new SimRelay({ replay: true }), owner = who(), member = who(), stored = cache()
    const a = await open(owner, relay, stored), b = await open(member, relay)
    try {
      await a.create(definition(owner, member), 'create-save-failure-01'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects).toHaveLength(1))
      const project = a.snapshot().projects[0]!, before = relay.published.length
      await expect(b.updateLogo(project, project.heads, [], image, 'non-owner-logo-change')).rejects.toThrow('Only the project owner')
      vi.spyOn(stored, 'save').mockRejectedValueOnce(new Error('disk full'))
      await expect(a.updateLogo(project, project.heads, [], image, 'failed-logo-save-001')).rejects.toThrow('disk full')
      expect(relay.published).toHaveLength(before)
      expect(a.snapshot().projects[0]!.logo).toBeUndefined(); expect(a.snapshot().ready).toBe(false)
    } finally { await a.close(); await b.close() }
  })

  it('rejects a missing guarded carrier before asking the signer for a logo', async () => {
    const relay = new SimRelay({ replay: true }), owner = who(), transport = new SimTransport(relay)
    const signer = { ...owner, signEvent: vi.fn(owner.signEvent) }
    const a = new ProjectDirectory({ identity: signer, transport, storage: cache() })
    await a.open(); await vi.waitFor(() => expect(a.snapshot().ready).toBe(true))
    try {
      await a.create(definition(owner), 'create-unguarded-logo-01'); await synced(a)
      signer.signEvent.mockClear()
      const project = a.snapshot().projects[0]!
      await expect(a.updateLogo(project, project.heads, [], image, 'unguarded-logo-change')).rejects.toThrow('safely publish')
      expect(signer.signEvent).not.toHaveBeenCalled()
    } finally { await a.close() }
  })

  it('rechecks membership after a delayed carrier and never sends the old logo to a removed member', async () => {
    const relay = new SimRelay({ replay: true }), owner = who(), member = who(), transport = new GuardedTransport(relay)
    const a = await open(owner, relay, cache(), transport)
    try {
      await a.create(definition(owner, member), 'create-delayed-logo-01'); await synced(a)
      let release!: () => void, entered = false
      const send = transport.publishGuarded.bind(transport)
      vi.spyOn(transport, 'publishGuarded').mockImplementation(async (event, current) => {
        if (!entered) { entered = true; await new Promise<void>(resolve => { release = resolve }) }
        await send(event, current)
      })
      const project = a.snapshot().projects[0]!
      await a.updateLogo(project, project.heads, [], image, 'delayed-logo-request-01')
      await vi.waitFor(() => expect(entered).toBe(true))
      const branded = a.snapshot().projects[0]!
      await a.update(branded, branded.heads, definition(owner), 'remove-during-logo-send')
      release()
      await vi.waitFor(async () => { await a.retry(); expect(a.snapshot().pendingSends).toBe(0) }, { timeout: 10_000 })
      const wraps = relay.published.filter(event => event.tags.some(tag => tag[0] === 'l' && tag[1] === PROJECT_LOGO_APP))
      expect(wraps).toHaveLength(1)
      expect(wraps[0]!.tags[0]![1]).toBe(owner.pubkey)
      expect(a.snapshot().projects[0]!.logo).toEqual(image)
    } finally { await a.close() }
  })

  it('drops a superseded offline outbox instead of retrying an obsolete logo indefinitely', async () => {
    const relay = new SimRelay({ replay: true }), owner = who(), transport = new GuardedTransport(relay), a = await open(owner, relay, cache(), transport)
    try {
      await a.create(definition(owner), 'create-superseded-logo'); await synced(a)
      const publish = vi.spyOn(transport, 'publishGuarded').mockRejectedValue(new Error('offline'))
      const project = a.snapshot().projects[0]!
      await a.updateLogo(project, project.heads, [], image, 'superseded-logo-request')
      await vi.waitFor(() => expect(publish).toHaveBeenCalled())
      const context = { reference: project, definition: project.definition! }
      const replacement = await signProjectLogo(owner, context, { v: 1, op: 'logo', project: project.project, authority: project.authority!, version: 2, request: 'other-device-logo-change', image: null })
      relay.publish(wrapProjectLogo(replacement, owner.pubkey, context))
      await vi.waitFor(() => { expect(a.snapshot().projects[0]!.logo).toBeNull(); expect(a.snapshot().pendingSends).toBe(0) })
      publish.mockClear(); await a.retry()
      expect(publish).not.toHaveBeenCalled()
    } finally { await a.close() }
  })

  it('keeps the authority guard valid after an ACK but cancels a delayed secondary delivery after removal', async () => {
    const relay = new SimRelay({ replay: true }), inbox = new SimRelay(), owner = who(), member = who()
    let release!: () => void, entered = false, finished = false
    const a = new ProjectDirectory({ identity: owner, transport: new GuardedTransport(relay), storage: cache(),
      deliverGuarded: async (event, recipient, current) => {
        expect(recipient).toBe(member.pubkey)
        expect(current()).toBe(true)
        entered = true; await new Promise<void>(resolve => { release = resolve })
        if (current()) inbox.publish(event)
        finished = true
      } })
    await a.open(); await vi.waitFor(() => expect(a.snapshot().ready).toBe(true))
    try {
      await a.create(definition(owner, member), 'create-secondary-logo-01'); await synced(a)
      const project = a.snapshot().projects[0]!
      await a.updateLogo(project, project.heads, [], image, 'secondary-logo-request')
      await synced(a); await vi.waitFor(() => expect(entered).toBe(true))
      const branded = a.snapshot().projects[0]!
      await a.update(branded, branded.heads, definition(owner), 'remove-before-inbox-send'); await synced(a)
      release(); await vi.waitFor(() => expect(finished).toBe(true))
      expect(inbox.published).toEqual([])
    } finally { await a.close() }
  })

  it('suppresses late signing after closing the directory without changing the retained journal', async () => {
    const relay = new SimRelay({ replay: true }), owner = who(), stored = cache()
    let release!: () => void, entered = false
    const signer = { ...owner, signEvent: async (template: Parameters<ProjectIdentity['signEvent']>[0]) => {
      if (template.tags?.some(tag => tag[0] === 'l' && tag[1] === PROJECT_LOGO_APP)) { entered = true; await new Promise<void>(resolve => { release = resolve }) }
      return owner.signEvent(template)
    } }
    const a = await open(signer, relay, stored)
    await a.create(definition(owner), 'create-late-sign-logo-01'); await synced(a)
    const project = a.snapshot().projects[0]!, retained = await stored.load(), before = relay.published.length
    const saving = a.updateLogo(project, project.heads, [], image, 'late-logo-sign-request').catch(error => error)
    await vi.waitFor(() => expect(entered).toBe(true))
    const closed = a.close(); release(); await closed
    expect(await saving).toBeInstanceOf(Error)
    expect(await stored.load()).toBe(retained); expect(relay.published).toHaveLength(before)
  })
})
