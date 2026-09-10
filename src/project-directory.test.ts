import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from './identity.js'
import { localPeerCrypt } from './dm.js'
import { ProjectDirectory, type ProjectDirectoryStorage } from './project-directory.js'
import { projectAuthority, signProject, unwrapProject, wrapProject, type ProjectDefinition, type ProjectIdentity } from './projects.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const identity = (): ProjectIdentity => { const sk = generateSecretKey(); return { ...localIdentity(sk), ...localPeerCrypt(sk) } }
const definition = (name: string, ...members: ProjectIdentity[]): ProjectDefinition => ({ name, archived: false, authorityRevision: 1, rooms: [], members: members.map(p => ({ pubkey: p.pubkey, kind: 'person', epoch: 1 })) })
function storage() {
  let value: string | undefined
  return { async load() { return value }, async save(next: string) { value = next } } satisfies ProjectDirectoryStorage
}
async function open(who: ProjectIdentity, relay: SimRelay, cache = storage(), transport = new SimTransport(relay)) {
  const d = new ProjectDirectory({ identity: who, transport, storage: cache })
  await d.open(); await vi.waitFor(() => expect(d.snapshot().ready).toBe(true)); return d
}
const synced = async (...directories: ProjectDirectory[]) => { await vi.waitFor(() => { for (const d of directories) expect(d.snapshot().pendingSends).toBe(0) }, { timeout: 10_000 }) }

describe('shared projects across independent people and devices', () => {
  it('shares three overlapping and disjoint projects, syncs a deliberate join and restores encrypted state without relay history', async () => {
    const relay = new SimRelay({ replay: true }), alice = identity(), bob = identity(), carol = identity(), agent = identity()
    const aCache = storage(), bCache = storage()
    const a = await open(alice, relay, aCache), b = await open(bob, relay, bCache), c = await open(carol, relay), worker = await open(agent, relay)
    const dirs = [a, b, c, worker]
    try {
      await a.create(definition('Kithmoot', alice, bob, agent), 'create-kithmoot-0001')
      await a.create(definition('Bothy', alice, carol, agent), 'create-bothy-000001')
      await c.create(definition('Private research', carol), 'create-research-001')
      await synced(...dirs)
      await vi.waitFor(() => {
        expect(b.snapshot().projects.map(p => p.definition?.name)).toEqual(['Kithmoot'])
        expect(c.snapshot().projects.map(p => p.definition?.name)).toEqual(['Bothy', 'Private research'])
        expect(worker.snapshot().projects.map(p => p.definition?.name)).toEqual(['Bothy', 'Kithmoot'])
      })
      expect(b.snapshot().projects[0]!.joined).toBe(false)
      const invitation = b.snapshot().projects[0]!
      await b.follow(invitation, true, invitation.heads, 'join-kithmoot-00001'); await synced(b)
      const phone = await open(bob, relay); dirs.push(phone)
      await vi.waitFor(() => expect(phone.snapshot().projects[0]?.joined).toBe(true))
      expect(JSON.stringify(relay.published)).not.toContain('Kithmoot')
      expect(JSON.stringify(relay.published)).not.toContain(invitation.project)
      expect(await aCache.load()).not.toContain('Bothy')
      expect(await bCache.load()).not.toContain('Kithmoot')
      await b.close()
      const recovered = await open(bob, new SimRelay(), bCache); dirs.push(recovered)
      expect(recovered.snapshot().projects[0]).toMatchObject({ joined: true, definition: { name: 'Kithmoot' } })
      await expect(recovered.update(invitation, invitation.heads, definition('Stolen', bob), 'forged-project-0001')).rejects.toThrow('Only the project owner')
      const wrong = new ProjectDirectory({ identity: carol, transport: new SimTransport(relay), storage: bCache })
      await expect(wrong.open()).rejects.toThrow('another identity'); await wrong.close()
    } finally { await Promise.all(dirs.map(d => d.close())) }
  }, 20_000)

  it('keeps metadata changes out of authority and requires a fresh join after removal and re-addition', async () => {
    const relay = new SimRelay({ replay: true }), alice = identity(), bob = identity()
    const a = await open(alice, relay), b = await open(bob, relay)
    try {
      await a.create(definition('Original name', alice, bob), 'create-project-00001'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects).toHaveLength(1))
      const initial = b.snapshot().projects[0]!
      await b.follow(initial, true, initial.heads, 'join-project-000001'); await synced(b)
      await a.update(initial, initial.heads, { ...initial.definition!, name: 'Renamed' }, 'rename-project-0001'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects[0]!.definition!.name).toBe('Renamed'))
      const renamed = a.snapshot().projects[0]!
      expect(renamed.authority).toBe(initial.authority)
      const observed = { ...renamed, head: renamed.heads[0]! }
      expect(projectAuthority(observed, renamed.definition!)).toBe(initial.authority)
      await a.update(renamed, renamed.heads, definition('Renamed', alice), 'remove-person-00001'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects[0]!.withdrawn).toBe(true))
      const removed = a.snapshot().projects[0]!
      await a.update(removed, removed.heads, definition('Renamed', alice, bob), 'restore-person-0001'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects[0]!.withdrawn).toBe(false))
      const readded = b.snapshot().projects[0]!
      expect(readded.joined).toBe(false)
      expect(readded.authority).not.toBe(initial.authority)
      expect(readded.definition!.members.find(m => m.pubkey === bob.pubkey)!.epoch).toBe(readded.revision)
      const late = await open(bob, relay)
      try { expect(late.snapshot().projects[0]!.joined).toBe(false) } finally { await late.close() }
      await b.follow(readded, true, readded.heads, 'join-again-00000001'); await synced(b)
      expect(b.snapshot().projects[0]!.joined).toBe(true)
    } finally { await Promise.all([a.close(), b.close()]) }
  }, 20_000)

  it('surfaces concurrent owner revisions and requires the exact known heads to resolve them', async () => {
    const owner = identity(), relay = new SimRelay({ replay: true }), a = await open(owner, relay)
    try {
      await a.create(definition('Start', owner), 'create-concurrent-01'); await synced(a)
      const initial = a.snapshot().projects[0]!
      const record = { v: 1 as const, op: 'snapshot' as const, project: initial.project, revision: 2, parents: initial.heads }
      const left = await signProject(owner, { ...record, request: 'concurrent-left-001', definition: { ...initial.definition!, name: 'Left' } })
      const right = await signProject(owner, { ...record, request: 'concurrent-right-01', definition: { ...initial.definition!, name: 'Right' } })
      relay.publish(wrapProject(left, owner.pubkey)); relay.publish(wrapProject(right, owner.pubkey))
      await vi.waitFor(() => expect(a.snapshot().projects[0]!.conflicted).toBe(true))
      const conflict = a.snapshot().projects[0]!
      expect(conflict.definition).toBeUndefined()
      await expect(a.update(conflict, [left.id], definition('Lost update', owner), 'incomplete-merge-01')).rejects.toThrow('Project changed')
      await a.update(conflict, conflict.heads, definition('Resolved', owner), 'resolve-project-001'); await synced(a)
      expect(a.snapshot().projects[0]).toMatchObject({ revision: 3, conflicted: false, definition: { name: 'Resolved' } })
      relay.publish(wrapProject(left, owner.pubkey))
      await new Promise(r => setTimeout(r, 20))
      expect(a.snapshot().projects[0]!.definition!.name).toBe('Resolved')
    } finally { await a.close() }
  })

  it('persists exact failed sends, keeps outstanding withdrawal notices through later edits, and does not publish after a failed save', async () => {
    const relay = new SimRelay({ replay: true }), owner = identity(), member = identity(), cache = storage()
    const transport = new SimTransport(relay), publish = vi.spyOn(transport, 'publish')
    const a = await open(owner, relay, cache, transport), b = await open(member, relay)
    try {
      await a.create(definition('Shared', owner, member), 'create-outbox-00001'); await synced(a)
      publish.mockRejectedValue(new Error('offline'))
      const initial = a.snapshot().projects[0]!
      await a.update(initial, initial.heads, definition('Owner only', owner), 'remove-offline-0001')
      await vi.waitFor(() => expect(publish.mock.results.length).toBeGreaterThan(2))
      const removed = a.snapshot().projects[0]!
      await a.update(removed, removed.heads, definition('Later edit', owner), 'later-offline-00001')
      await a.close()
      const restartedTransport = new SimTransport(relay)
      const restored = await open(owner, relay, cache, restartedTransport)
      try {
        expect(restored.snapshot().pendingSends).toBe(2)
        await restored.retry(); await synced(restored)
        await vi.waitFor(() => expect(b.snapshot().projects[0]!.withdrawn).toBe(true))
        expect(restored.snapshot().projects[0]!.definition!.name).toBe('Later edit')
        const before = relay.published.length, current = restored.snapshot().projects[0]!
        vi.spyOn(cache, 'save').mockRejectedValueOnce(new Error('disk full'))
        await expect(restored.update(current, current.heads, definition('Must not publish', owner), 'failed-save-0000001')).rejects.toThrow('disk full')
        expect(relay.published).toHaveLength(before)
        expect(restored.snapshot().projects[0]!.definition!.name).toBe('Later edit')
      } finally { await restored.close() }
      const leaked = relay.published.find(e => e.tags.some(t => t[0] === 'p' && t[1] === member.pubkey))!
      expect(await unwrapProject(leaked, identity())).toBeUndefined()
    } finally { await Promise.all([a.close(), b.close()]) }
  }, 20_000)
})
