import { describe, expect, it, vi } from 'vitest'
import { getPublicKey, type Event } from 'nostr-tools/pure'
import { readNodeRoom, signNodeRoom } from '@forgesworn/fold-kit/node-room'
import { nodeMigrationDigest, readNodeMigrationPreparation, signNodeMigrationPreparation } from '@forgesworn/fold-kit/node-migration'
import { buildGrant } from './group-grants.js'
import { NodeMigrationCoordinator, type NodeMigrationContext, type NodeMigrationJournal, type NodeMigrationPorts } from './node-migration.js'

const now = 1_900_000_000, authoritySk = new Uint8Array(32).fill(1)
const deviceKeys = [2, 3, 4].map(n => new Uint8Array(32).fill(n))
const endpoints = deviceKeys.map((sk, i) => ({ device: getPublicKey(sk), sid: ['desktop-session', 'android-session', 'browser-session'][i]! }))
const node = readNodeRoom(signNodeRoom({ authoritySk, room: '09'.repeat(32), origin: 'https://node.example',
  serviceKey: getPublicKey(new Uint8Array(32).fill(7)), now, existing: { destruct: false } }), now)!
const prepared = signNodeMigrationPreparation({ node, authoritySk, operation: 'ab'.repeat(16), endpoints, epoch: 3, now })
function fixture(index: number) {
  let persisted: NodeMigrationJournal | undefined
  const context: NodeMigrationContext = { room: node.room, authority: node.authority, epoch: 3, destruct: false, endpoint: endpoints[index]!, endpoints: [...endpoints] }
  const evidence: Event[] = [], frozen: boolean[] = []
  const ports: NodeMigrationPorts = {
    context: () => context, load: async () => persisted,
    save: vi.fn(async state => { persisted = JSON.parse(JSON.stringify(state)) }),
    freezeSourceWrites: vi.fn(value => { frozen.push(value) }), now: () => now,
    prepareDevice: vi.fn(async () => ({
      grant: buildGrant({ authoritySk, roomId: node.room, device: context.endpoint.device, server: 'node.example',
        scopes: ['turn', 'relay-read', 'relay-write'], grantId: String(index + 1).repeat(32), createdAt: now, expiration: now + 3600 }),
      history: { events: 0, digest: nodeMigrationDigest([]) },
    })),
    publishSourceEvidence: vi.fn(async e => { evidence.push(e) }),
    publishCommitEvidence: vi.fn(async () => {}), install: vi.fn(async () => {}),
  }
  return { ports, context, evidence, frozen, get persisted() { return persisted }, open: () => NodeMigrationCoordinator.open(ports, deviceKeys[index]!) }
}
async function readyRoom() {
  const fixtures = [0, 1, 2].map(fixture)
  const controllers = await Promise.all(fixtures.map(f => f.open()))
  const ready = await Promise.all(controllers.map(c => c.prepare(prepared)))
  await controllers[0]!.recordReady(ready[1]!); await controllers[0]!.recordReady(ready[2]!)
  return { fixtures, controllers, ready }
}
describe('durable existing-room handover', () => {
  it('requires desktop, Android and web readiness before publishing a committed decision', async () => {
    const root = fixture(0), coordinator = await root.open()
    await coordinator.prepare(prepared, true)
    expect(root.evidence[0]!.id).toBe(prepared.id)
    await expect(coordinator.commit(authoritySk)).rejects.toThrow()
    expect(root.ports.install).not.toHaveBeenCalled(); expect(root.ports.publishCommitEvidence).not.toHaveBeenCalled()
    const other = await Promise.all([1, 2].map(async index => { const f = fixture(index); return (await f.open()).prepare(prepared) }))
    for (const ready of other) await coordinator.recordReady(ready)
    await coordinator.commit(authoritySk)
    expect(root.persisted?.phase).toBe('committed')
    expect(root.ports.publishCommitEvidence).toHaveBeenCalledTimes(1)
    expect(root.ports.install).toHaveBeenCalledTimes(1)
    expect(root.frozen.slice(2)).not.toContain(false)
  })
  it('persists readiness before publishing and retries it after a lost acknowledgement', async () => {
    const f = fixture(0), coordinator = await f.open()
    f.ports.publishSourceEvidence = vi.fn(async () => { expect(f.persisted?.phase).toBe('ready'); throw Error('lost ACK') })
    await expect(coordinator.prepare(prepared)).rejects.toThrow('lost ACK')
    expect(f.persisted?.phase).toBe('ready')
    f.ports.publishSourceEvidence = vi.fn(async () => {})
    const resumed = await f.open(), ready = await resumed.prepare(prepared)
    expect(ready.id).toBe(f.persisted!.ready[0]!.id)
    expect(f.ports.prepareDevice).toHaveBeenCalledTimes(1)
    await expect(resumed.cancelBeforeReady()).rejects.toThrow('shared decision')
  })
  it('keeps writes frozen when delivery or installation fails and recovers the same saved decision', async () => {
    const { fixtures: [f], controllers: [root] } = await readyRoom()
    f!.ports.publishCommitEvidence = vi.fn(async commit => {
      expect(f!.persisted?.commit?.id).toBe(commit.event.id)
      throw Error('node temporarily unavailable')
    })
    await expect(root!.commit(authoritySk)).rejects.toThrow('unavailable')
    const decision = f!.persisted!.commit!.id
    expect(f!.persisted!.phase).toBe('committing'); expect(f!.ports.install).not.toHaveBeenCalled()
    f!.ports.publishCommitEvidence = vi.fn(async () => {})
    f!.ports.install = vi.fn(async () => { throw Error('storage full') })
    const recovered = await f!.open()
    await expect(recovered.resumeCommit(true)).rejects.toThrow('storage full')
    expect(f!.persisted!.commit!.id).toBe(decision); expect(f!.frozen.slice(2)).not.toContain(false)
    f!.ports.install = vi.fn(async () => {})
    await recovered.resumeCommit(true)
    expect(f!.persisted!.phase).toBe('committed'); expect(f!.persisted!.commit!.id).toBe(decision)
  })
  it('blocks a changed epoch or active client set before committing', async () => {
    for (const change of [(c: NodeMigrationContext) => { c.epoch++ }, (c: NodeMigrationContext) => { c.endpoints = c.endpoints.slice(1) }]) {
      const { fixtures: [f], controllers: [root] } = await readyRoom()
      change(f!.context)
      await expect(root!.commit(authoritySk)).rejects.toThrow('changed')
      expect(f!.ports.install).not.toHaveBeenCalled(); expect(f!.ports.publishCommitEvidence).not.toHaveBeenCalled()
    }
  })
  it('does not publish readiness after a failed durable save and permits cancellation before readiness', async () => {
    const f = fixture(0), coordinator = await f.open()
    f.ports.prepareDevice = vi.fn(async () => { throw Error('history unavailable') })
    await expect(coordinator.prepare(prepared)).rejects.toThrow('history unavailable')
    expect(f.evidence).toHaveLength(0)
    await coordinator.cancelBeforeReady()
    expect(f.persisted!.phase).toBe('cancelled'); expect(f.frozen.at(-1)).toBe(false)
    const other = fixture(1), c = await other.open()
    const save = other.ports.save
    other.ports.save = async state => { if (state.phase === 'ready') throw Error('disk full'); await save(state) }
    await expect(c.prepare(prepared)).rejects.toThrow('disk full')
    expect(other.persisted!.phase).toBe('preparing'); expect(other.evidence).toHaveLength(0)
  })
  it('adopts a verified decision on each other client without rebroadcasting or changing room policy', async () => {
    const { fixtures, controllers } = await readyRoom()
    await controllers[0]!.commit(authoritySk)
    const decision = fixtures[0]!.persisted!.commit!
    for (const index of [1, 2]) {
      await controllers[index]!.receiveCommit(decision)
      expect(fixtures[index]!.persisted!.phase).toBe('committed')
      expect(fixtures[index]!.ports.publishCommitEvidence).not.toHaveBeenCalled()
      expect(fixtures[index]!.context.destruct).toBe(false)
    }
    const wrong = fixture(0); wrong.context.destruct = true
    await expect((await wrong.open()).receiveCommit(decision)).rejects.toThrow('policy')
    expect(wrong.ports.install).not.toHaveBeenCalled()
  })
  it('keeps a saved private route after the network replay window expires and fences failed storage reads', async () => {
    const { fixtures: [f], controllers: [root] } = await readyRoom()
    await root!.commit(authoritySk)
    const original = f!.persisted!.commit!.id
    f!.ports.now = () => now + 60 * 86400
    const reopened = await f!.open()
    await reopened.resumeCommit(false)
    expect(reopened.state?.commit?.id).toBe(original)
    expect(f!.frozen.slice(2)).not.toContain(false)
    const broken = fixture(0)
    broken.ports.load = async () => { throw Error('storage unavailable') }
    await expect(broken.open()).rejects.toThrow('storage unavailable')
    expect(broken.frozen).toEqual([true])
  })
  it('does not reopen source writes from a damaged journal or stale preparation', async () => {
    const f = fixture(0)
    f.ports.load = async () => ({ v: 1, phase: 'committing', preparation: prepared, ready: [] })
    await expect(f.open()).rejects.toThrow('Missing saved')
    expect(f.frozen).toEqual([true])
    f.ports.load = async () => ({ v: 1, phase: 'ready', preparation: prepared, ready: [] })
    f.ports.now = () => now + 600
    await expect(f.open()).rejects.toThrow('current decision')
    expect(readNodeMigrationPreparation(prepared, now + 600, node.authority)).toBeNull()
  })
})
