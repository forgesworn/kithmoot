import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'

/**
 * One keeper per state file.
 *
 * A keeper is its room's authority, and two of them on one state file would
 * each sign a rekey for the same epoch: two secrets, each member following
 * whichever reached them first, and the room split. So `kithmoot-agent
 * create --state <file>` takes `<file>.lock` first, created exclusively
 * (`O_EXCL`), holding the process id, the host and, on Linux, the boot id.
 * It is removed on a clean exit, however the process exits short of being
 * killed outright.
 *
 * A lock left behind by a keeper that was killed (SIGKILL, the OOM killer,
 * a power cut) is stale, and is taken over when:
 * - the boot id it names is not this boot's: the machine has restarted;
 * - the process it names is not running on this host (`kill(pid, 0)` says
 *   ESRCH);
 * - it names this very process id, but this process does not hold it: a
 *   container whose keeper is always pid 1, restarted;
 * - it is unreadable and more than a minute old: a crash between creating
 *   the file and writing it.
 * A lock from another host is never taken over, since nothing here can see
 * that host's processes: a state file on a shared disk is the case the lock
 * exists for. The pid check can be fooled into refusing by an unrelated
 * process that has since been given the same pid; the error says which
 * process and which file, and deleting the lock is the way out.
 */

export interface StateLockInfo {
  pid: number
  host: string
  boot?: string
  /** Unix seconds. */
  at: number
}

export class StateLockHeldError extends Error {
  readonly holder?: StateLockInfo
  constructor(lockPath: string, holder?: StateLockInfo) {
    super(
      holder
        ? `${lockPath} is held by process ${holder.pid} on ${holder.host}: another keeper is running on this state file. ` +
            `Stop it first. If no keeper is running${holder.host === hostname() ? '' : ' on that host'}, delete ${lockPath}.`
        : `${lockPath} exists and cannot be read: another keeper may be starting on this state file. ` +
            `If none is, delete ${lockPath}.`,
    )
    this.name = 'StateLockHeldError'
    this.holder = holder
  }
}

export interface StateLockOptions {
  /** For tests: who this process says it is. */
  pid?: number
  host?: string
  boot?: string | null
  now?: () => number
  /** For tests: whether a process is running on this host. */
  alive?: (pid: number) => boolean
}

export interface StateLock {
  readonly path: string
  /** Remove the lock if it is still this process's. Idempotent. */
  release(): void
}

/** Locks this process holds, by path, so a second take in the same process
 *  is refused too. */
const heldHere = new Set<string>()

function currentBoot(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, and belongs to somebody else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLock(path: string): StateLockInfo | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StateLockInfo>
    if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0 || typeof raw.host !== 'string') return undefined
    return {
      pid: raw.pid as number,
      host: raw.host,
      ...(typeof raw.boot === 'string' ? { boot: raw.boot } : {}),
      at: typeof raw.at === 'number' ? raw.at : 0,
    }
  } catch {
    return undefined
  }
}

/**
 * Take `<statePath>.lock`, or throw `StateLockHeldError` naming who holds
 * it. See the module comment for when a lock left behind is taken over.
 */
export function acquireStateLock(statePath: string, opts: StateLockOptions = {}): StateLock {
  const path = `${statePath}.lock`
  const pid = opts.pid ?? process.pid
  const host = opts.host ?? hostname()
  const boot = opts.boot === null ? undefined : (opts.boot ?? currentBoot())
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const alive = opts.alive ?? processAlive
  if (heldHere.has(path)) throw new StateLockHeldError(path, readLock(path) ?? { pid, host, at: now() })
  const mine: StateLockInfo = { pid, host, ...(boot ? { boot } : {}), at: now() }
  const body = JSON.stringify(mine) + '\n'

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const holder = readLock(path)
      if (attempt === 0 && stale(path, holder, { pid, host, boot, now, alive })) {
        try {
          unlinkSync(path)
        } catch (gone) {
          if ((gone as NodeJS.ErrnoException).code !== 'ENOENT') throw gone
        }
        continue
      }
      throw new StateLockHeldError(path, holder)
    }
    try {
      writeSync(fd, body)
    } finally {
      closeSync(fd)
    }
    heldHere.add(path)
    let released = false
    return {
      path,
      release() {
        if (released) return
        released = true
        heldHere.delete(path)
        // Only ever our own: a lock taken over by somebody else since is theirs.
        const now = readLock(path)
        if (!now || now.pid !== mine.pid || now.host !== mine.host || now.at !== mine.at) return
        try {
          unlinkSync(path)
        } catch {
          // Already gone.
        }
      },
    }
  }
  throw new StateLockHeldError(path, readLock(path))
}

function stale(
  path: string,
  holder: StateLockInfo | undefined,
  self: { pid: number; host: string; boot?: string; now: () => number; alive: (pid: number) => boolean },
): boolean {
  if (!holder) {
    // Unreadable: a crash between creating it and writing it, if it is old;
    // a keeper starting this instant, if it is not.
    try {
      return self.now() - Math.floor(statSync(path).mtimeMs / 1000) > 60
    } catch {
      return true
    }
  }
  if (holder.host !== self.host) return false
  if (holder.boot && self.boot && holder.boot !== self.boot) return true
  if (holder.pid === self.pid) return true
  return !self.alive(holder.pid)
}
