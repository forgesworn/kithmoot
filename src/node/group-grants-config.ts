import { mkdir, readFile, rename, rm, writeFile, stat } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { GroupGrantKeeper, parseLedger, roomListsNodesMessage, type GroupGrantStore, type GroupGrantsConfig } from '../group-grants-keeper.js'
import type { KeeperState } from '../agent.js'

/** Where the keeper's group grant ledger lives: beside its state file, under the same lock. */
export const groupGrantLedgerPath = (statePath: string): string => `${statePath}.grants`

/** Ledgers moved aside by `--group-reset`: they hold the same participant-to-device map, so a self-destruct removes them too. */
export function movedAsideLedgers(statePath: string): string[] {
  const dir = dirname(statePath)
  const prefix = `${basename(groupGrantLedgerPath(statePath))}.unreadable-`
  try { return readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => join(dir, f)) } catch { return [] }
}

/**
 * The ledger as a file: private (0600), replaced whole by writing a temporary
 * file beside it and renaming, so a keeper killed mid-write leaves the last
 * good ledger. Never deletes: `moveAside` renames.
 */
export class FileGroupGrantStore implements GroupGrantStore {
  #tmp = 0
  constructor(readonly path: string) {}

  async load(): Promise<string | undefined> {
    try { return await readFile(this.path, 'utf8') } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }

  async save(json: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${++this.#tmp}.tmp`
    try {
      await writeFile(tmp, json, { mode: 0o600 })
      await rename(tmp, this.path)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  async moveAside(unixSeconds: number): Promise<string | undefined> {
    let target = `${this.path}.unreadable-${unixSeconds}`
    for (let n = 1; await stat(target).then(() => true, () => false); n++) target = `${this.path}.unreadable-${unixSeconds}-${n}`
    try { await rename(this.path, target) } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
    return target
  }
}

export interface GroupGrantFlags {
  /** `--group-node` values, already split on commas. */
  nodes: string[]
  /** `--group-bytes`. */
  bytes?: string
  reset: boolean
  /** `--group-withdraw`: stop listing the room's storage nodes. */
  withdraw?: boolean
  command: string
  statePath?: string
  log: (line: string) => void
}

/**
 * The flags to a `GroupGrantsConfig`, or undefined when none were given (a
 * keeper that does not use group nodes is not told of them at all). Throws an
 * Error whose message is fit to print.
 */
export function groupGrantsFromFlags(flags: GroupGrantFlags): GroupGrantsConfig | undefined {
  const { nodes, bytes, reset } = flags
  if (flags.withdraw) {
    if (flags.command !== 'create') throw new Error('--group-withdraw is for a keeper (create): only a room\'s keeper signs the list of storage nodes')
    if (nodes.length) throw new Error('--group-withdraw stops the room listing storage nodes, so it cannot be given with --group-node')
    if (bytes !== undefined) throw new Error('--group-withdraw is not combined with --group-bytes: a withdrawn room mints nothing, so it has no ceiling to set')
    if (!flags.statePath) throw new Error('--group-withdraw needs --state <file>: the keeper records that the room lists no nodes beside its state')
    return withdrawnGroupGrants(flags.statePath, flags.log, reset)
  }
  if (!nodes.length && bytes === undefined && !reset) return undefined
  if (flags.command !== 'create') throw new Error('--group-node, --group-bytes, --group-reset and --group-withdraw are for a keeper (create): only a room\'s keeper signs grants')
  if (!nodes.length) throw new Error('--group-bytes and --group-reset need at least one --group-node <url> (or, for a room that lists no nodes, --group-reset goes with --group-withdraw)')
  if (bytes === undefined || bytes.trim() === '') {
    throw new Error('--group-node needs --group-bytes <n>: the most a device may upload to a node, in bytes. It is the choice of whoever runs the node and has no default.')
  }
  if (!flags.statePath) throw new Error('group grants need --state <file>: the keeper keeps what it has signed beside its state (<file>.grants), and a restart without it would lose it')
  const config: GroupGrantsConfig = {
    nodes, bytes: bytes.trim(), store: new FileGroupGrantStore(groupGrantLedgerPath(flags.statePath)),
    ...(reset ? { resetUnreadable: true } : {}), log: flags.log,
  }
  GroupGrantKeeper.validate(config)
  return config
}

/**
 * The grant keeper's configuration for a room that lists no storage nodes
 * (`--group-withdraw`, or a later start with no group flags whose state holds
 * `storage: []`). It runs over the existing ledger only: it mints and renews
 * nothing and signs no resets, but a removal still revokes at every node the
 * ledger names. With no ledger file the room agent does not start it. With
 * `reset` (`--group-withdraw --group-reset`), an unreadable ledger is moved
 * aside, never deleted, and the room starts withdrawn with no grant keeper.
 */
export function withdrawnGroupGrants(statePath: string, log: (line: string) => void, reset = false): GroupGrantsConfig {
  const config: GroupGrantsConfig = {
    nodes: [], bytes: '', withdrawn: true, store: new FileGroupGrantStore(groupGrantLedgerPath(statePath)),
    ...(reset ? { resetUnreadable: true } : {}), log,
  }
  GroupGrantKeeper.validate(config)
  return config
}

/**
 * The downgrade guard. A keeper that ran with group nodes keeps a grant
 * ledger beside its state, but an older keeper build drops the `storage` field
 * from the state when it next writes it, and a keeper started with the nodes'
 * flags removed lists none. So when no group flags are given and the state
 * does not say what the room lists, the ledger is looked at: if it names any
 * node, the start is refused with the same message as a state that lists them,
 * and the hosts are the ledger's. `--group-withdraw` is the way out. A state
 * that records `storage` (even `[]`) is judged by the room agent itself.
 * Throws an Error whose message is fit to print; resolves for a fresh room, a
 * room with no ledger, or a ledger that names nothing.
 */
export async function refuseSilentWithdrawal(statePath: string, state: KeeperState | undefined): Promise<void> {
  if (!state || state.storage !== undefined) return
  const text = await new FileGroupGrantStore(groupGrantLedgerPath(statePath)).load()
  if (text === undefined) return
  let hosts: string[]
  try { hosts = Object.keys(parseLedger(text).bases).sort() } catch { return }
  if (hosts.length) throw new Error(roomListsNodesMessage(hosts))
}
