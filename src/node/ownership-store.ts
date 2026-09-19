import { closeSync, constants, fsyncSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OwnershipRegistry, type OwnershipEventStore } from '../ownership-registry.js'

const KEY = /^kithmoot\.ownership\.v1\.[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{64}$/
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** Immutable per-event files keep independent processes from replacing newer
 * evidence. Readers consult disk every time; no process-local authority cache.
 * Errors propagate to OwnershipRegistry, which refuses the authority. */
export class OwnershipFileStore implements OwnershipEventStore {
  readonly directory: string
  constructor(directory: string) { this.directory = resolve(directory) }
  private ready(): void { mkdirSync(this.directory, { recursive: true, mode: 0o700 }) }
  private path(key: string): string {
    if (!KEY.test(key)) throw new Error('Invalid ownership storage key')
    return join(this.directory, key)
  }
  keys(): string[] {
    this.ready()
    return readdirSync(this.directory).filter(key => KEY.test(key))
  }
  get(key: string): string | null {
    let fd: number
    try { fd = openSync(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if (missing(error)) return null; throw error }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid ownership event file')
      return readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
  }
  private flush(): void {
    const fd = openSync(this.directory, constants.O_RDONLY)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  set(key: string, value: string): void {
    const target = this.path(key)
    if (Buffer.byteLength(value, 'utf8') > 8192) throw new Error('Ownership event too large')
    this.ready()
    const temp = join(this.directory, `.pending-${randomUUID()}`)
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, value, 'utf8'); fsyncSync(fd) }
    finally { closeSync(fd) }
    try {
      try { linkSync(temp, target) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || this.get(key) !== value) throw error
      }
      this.flush()
    } finally { unlinkSync(temp) }
  }
  remove(key: string): void {
    try { unlinkSync(this.path(key)) }
    catch (error) { if (!missing(error)) throw error }
    this.flush()
  }
}

/** Operator-supplied ordinary event only. Does not read identity keys or contact
 * relays. Sessions sharing the directory see it at their next authority check. */
export function rememberOwnershipFile(path: string, store: OwnershipEventStore, now = Math.floor(Date.now() / 1000)): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let raw: string
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 8192) throw new Error('Ownership event file must be at most 8192 bytes')
    raw = readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
  if (!new OwnershipRegistry(store).observe(JSON.parse(raw), now)) throw new Error('Ownership event was invalid or could not be remembered')
}
