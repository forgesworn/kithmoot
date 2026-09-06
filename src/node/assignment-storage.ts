import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AssignmentStorage } from '../assignment-log.js'

export async function atomicPrivateWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(data, 'utf8'); await file.sync() } finally { await file.close() }
    await rename(temp, path)
    const dir = await open(dirname(path), 'r')
    try { await dir.sync() } finally { await dir.close() }
  } finally { await unlink(temp).catch(() => {}) }
}

/** The OS releases SQLite's exclusive lock when a writer exits, including a
 * crash. Reopening this cache never authorises execution: the independent
 * durable execution journal retains every uncertain attempt. */
export async function openAssignmentStorage(path: string): Promise<AssignmentStorage & { close(): Promise<void> }> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const { DatabaseSync } = await import('node:sqlite')
  const lockPath = `${path}.writers.sqlite`
  const file = await open(lockPath, 'a', 0o600); await file.close()
  const guard = new DatabaseSync(lockPath)
  try {
    guard.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    // An older development build used an explicit pid lock. Never overwrite
    // its cache while that writer is alive or cannot be inspected.
    try {
      const old = JSON.parse(await readFile(`${path}.lock`, 'utf8')) as { pid: number }
      if (!Number.isSafeInteger(old.pid) || old.pid < 1) throw new Error('Invalid legacy writer record')
      try { process.kill(old.pid, 0); throw new Error('Legacy assignment writer is still alive') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e }
      await unlink(`${path}.lock`)
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  } catch (e) {
    guard.close()
    throw new Error(`Assignment cache is locked or its prior writer cannot be inspected: ${e instanceof Error ? e.message : String(e)}`)
  }
  let closed = false
  return {
    async load() { try { return await readFile(path, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e } },
    async save(value) {
      if (closed) throw new Error('Assignment cache is closed')
      await atomicPrivateWrite(path, value)
    },
    async close() {
      if (closed) return
      closed = true
      try { guard.exec('ROLLBACK') } finally { guard.close() }
    },
  }
}
