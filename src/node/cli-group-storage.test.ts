import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex } from '@noble/hashes/utils'
import { generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent } from '../agent.js'
import type { KeeperState } from '../agent.js'
import { serialiseKeeperState } from '../keeper-state.js'
import { groupGrantLedgerPath } from './group-grants-config.js'
import { main } from './cli.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { FakeNodes, MemoryStore, waitFor } from '../../test/group-grants-fixtures.js'
import { localIdentity } from '../identity.js'

const BASE = 'https://example.test/j/'
const A = 'https://node-a.test:8080'
const B = 'https://node-b.test'

afterEach(() => { vi.restoreAllMocks() })

/** The CLI's `create`, with exit and stderr captured: what it printed, and how it ended. */
async function run(argv: string[]): Promise<{ outcome: string; said: string }> {
  const lines: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { lines.push(String(s)); return true }) as never)
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)
  const outcome = await main(argv).then(() => 'started', (e: Error) => e.message)
  return { outcome, said: lines.filter((l) => l.startsWith('kithmoot-agent:')).join('') }
}

describe('the CLI over a state an older keeper has rewritten', { timeout: 30_000 }, () => {
  /** A room that ran with two nodes, then a state with the list and the invitation dropped, as an S4 keeper writes it. */
  async function downgradedRoom(ledger?: string): Promise<{ statePath: string }> {
    const relay = new SimRelay({ replay: true })
    const fake = new FakeNodes('')
    const store = new MemoryStore()
    let last: KeeperState | undefined
    fake.clock = () => Math.floor(Date.now() / 1000)
    const keeper = await RoomAgent.create({
      base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: () => new SimTransport(relay), announceJitterMs: 0,
      onState: (s) => { last = s },
      groupGrants: { nodes: [A, B], bytes: 1_000_000, store, fetch: fake.fetch, backoff: { baseMs: 5, maxMs: 20 }, pushBudgetMs: 200, rosterDelayMs: 5, sweepIntervalMs: 3_600_000 },
    })
    fake.keeper = keeper.link.invitation!.inviter
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), transport: () => new SimTransport(relay), announceJitterMs: 0, timing: { heartbeatIntervalMs: 40 } })
    await waitFor(() => (keeper.groupGrantLedger?.grants.length ?? 0) === 2)
    await ada.leave()
    await keeper.leave()
    const { storage: _s, invitation: _i, compat: _c, storageAt: _a, ...older } = last ?? keeper.keeperState!
    const dir = await mkdtemp(join(tmpdir(), 'kithmoot-cli-guard-'))
    const statePath = join(dir, 'room.json')
    await writeFile(statePath, serialiseKeeperState(older as KeeperState))
    await writeFile(groupGrantLedgerPath(statePath), ledger ?? store.text!)
    return { statePath }
  }
  const create = (statePath: string, ...extra: string[]) =>
    ['create', '--base', BASE, '--name', 'Keeper', '--state', statePath, '--nsec', bytesToHex(generateSecretKey()), '--relay', 'wss://never.invalid', ...extra]

  it('refuses to start with no group flags, naming the ledger\'s hosts, exit 2, before any relay is contacted', async () => {
    const { statePath } = await downgradedRoom()
    const before = await readFile(statePath, 'utf8')
    const { outcome, said } = await run(create(statePath))
    expect(outcome).toBe('exit 2')
    expect(said).toContain('this room lists group storage nodes (node-a.test, node-b.test); start the keeper with the same --group-node and --group-bytes flags, or with --group-withdraw to stop listing them')
    // Refused before the room was opened: the state is as it was left.
    expect(await readFile(statePath, 'utf8')).toBe(before)
  })

  it('refuses a ledger it cannot read too, saying how to move it aside', async () => {
    const { statePath } = await downgradedRoom('not a ledger')
    const { outcome, said } = await run(create(statePath))
    expect(outcome).toBe('exit 2')
    expect(said).toContain('cannot be read, so the nodes it names cannot be known')
    expect(said).toContain('--group-withdraw --group-reset')
  })
})
