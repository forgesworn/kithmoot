import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { localPeerCrypt } from '../../src/dm.js'
import { ProjectDirectory } from '../../src/project-directory.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { memoryDeviceStore } from './device-store.js'
import { sharedProjectsStorage } from './shared-projects.js'

const identity = () => { const sk = generateSecretKey(); return { ...localIdentity(sk), ...localPeerCrypt(sk) } }

describe('browser shared-project journal adapter', () => {
  it('uses incremental storage and keeps project plaintext out of every record', async () => {
    const store = memoryDeviceStore()
    const who = identity()
    const relay = new SimRelay({ replay: true })
    const root = `kithmoot.shared-projects.v1.${who.pubkey}`
    const adapter = sharedProjectsStorage(root, store)
    expect(typeof adapter.loadIncremental).toBe('function')
    expect(typeof adapter.appendIncremental).toBe('function')
    const directory = new ProjectDirectory({ identity: who, transport: new SimTransport(relay), storage: adapter })
    await directory.open()
    await vi.waitFor(() => expect(directory.snapshot().ready).toBe(true))
    try {
      await directory.create({ name: 'Browser private project name', archived: false, authorityRevision: 1, rooms: [],
        members: [{ pubkey: who.pubkey, kind: 'person', epoch: 1 }] }, 'browser_project_req_01')
      await vi.waitFor(() => expect(directory.snapshot().pendingSends).toBe(0))
      const image = await adapter.loadIncremental()
      expect(image.deltas.length).toBeGreaterThan(0)
      expect(JSON.parse(store.get(root)!).v).toBe(2)
      expect(store.keys().some(key => key.startsWith(`${root}.journal.v2.`))).toBe(true)
      const physical = JSON.stringify({ keys: store.keys(), values: store.keys().map(key => store.get(key)) })
      for (const plaintext of ['Browser private project name', 'browser_project_req_01']) expect(physical).not.toContain(plaintext)
    } finally { await directory.close() }
    // The same keyed store reloads the journal with no relay history.
    const reopened = new ProjectDirectory({ identity: who, transport: new SimTransport(new SimRelay()), storage: sharedProjectsStorage(root, store) })
    await reopened.open()
    await vi.waitFor(() => expect(reopened.snapshot().ready).toBe(true))
    try {
      expect(reopened.snapshot().projects.map(project => project.definition?.name)).toEqual(['Browser private project name'])
    } finally { await reopened.close() }
  })
})
