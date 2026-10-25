import { afterEach, describe, expect, it } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent } from '../../src/agent.js'
import { localIdentity } from '../../src/identity.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { browserAssignmentStorage } from './assignment-panel.js'

const clients: RoomAgent[] = []
afterEach(() => { for (const client of clients.splice(0)) client.leave() })

describe('browser assignment journal adapter', () => {
  it('uses incremental storage and keeps assignment plaintext out of every record', async () => {
    const values = new Map<string, string>()
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const relay = new SimRelay({ replay: true }), transport = () => new SimTransport(relay)
    const identity = localIdentity(generateSecretKey())
    const creator = await RoomAgent.create({ base: 'https://example.test/j/', name: 'Person', agent: false, identity, transport, announceJitterMs: 0 })
    clients.push(creator)
    const worker = await RoomAgent.join({ link: creator.url, name: 'Worker', transport, announceJitterMs: 0 })
    clients.push(worker)
    const root = `kithmoot.assignments.v1.${creator.participant}.${creator.roomId}`
    const adapter = browserAssignmentStorage(root, local)
    expect(typeof adapter.loadIncremental).toBe('function')
    expect(typeof adapter.appendIncremental).toBe('function')
    const log = await creator.session.assignments(adapter)
    const created = await log.submit(undefined, { op: 'create', objective: 'Browser private objective', criteria: 'Encrypted side records', owner: worker.participant }, 'browser_private_request_01')
    const image = await adapter.loadIncremental()
    expect(image.deltas.length).toBeGreaterThan(0)
    expect(JSON.parse(values.get(root)!).v).toBe(2)
    expect([...values.keys()].some(key => key.startsWith(`${root}.journal.v2.`))).toBe(true)
    const physical = JSON.stringify([...values.values()])
    for (const plaintext of ['Browser private objective', 'Encrypted side records', 'browser_private_request_01', created.id]) expect(physical).not.toContain(plaintext)
  })
})
