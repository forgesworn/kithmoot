import { constants } from 'node:fs'
import { open, mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ContextVault, type ContextVaultOptions } from '../context.js'

/** One encrypted cache per identity AND scope. Reload inside the lock for each
 * operation so independent MCP processes cannot overwrite one another. */
export class ContextFileStore {
  readonly path: string
  constructor(path: string, readonly options: ContextVaultOptions) { this.path = resolve(path) }

  async run<T>(action: (vault: ContextVault) => Promise<T> | T, write = false): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const lockPath = this.path + '.lock'
    const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Context cache is busy. Retry after the other process finishes; a crash may require the operator to remove its stale lock.') })
    let temporary: string | undefined
    try {
      const vault = new ContextVault(this.options)
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(err => {
        if (err.code === 'ENOENT') return undefined
        throw new Error('Cannot open the encrypted context cache.')
      })
      if (handle) {
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > 90 * 1024 * 1024 || (stat.mode & 0o077)) throw new Error('Context cache must be a private regular file (chmod 600).')
          let saved
          try { saved = JSON.parse(await handle.readFile('utf8')) } catch { throw new Error('Invalid context cache file.') }
          if (saved.v !== 1 || saved.room !== (this.options.room ?? null) || typeof saved.vault !== 'string') throw new Error('Context cache scope does not match this adapter. Use a separate state file per room.')
          await vault.restore(saved.vault)
        } finally { await handle.close() }
      }
      const result = await action(vault)
      if (write) {
        const encrypted = JSON.stringify({ v: 1, room: this.options.room ?? null, vault: await vault.save() })
        temporary = this.path + '.' + randomUUID() + '.tmp'
        const output = await open(temporary, 'wx', 0o600)
        try { await output.writeFile(encrypted); await output.sync() } finally { await output.close() }
        await rename(temporary, this.path)
        temporary = undefined
      }
      return result
    } finally {
      if (temporary) await unlink(temporary).catch(() => {})
      await lock.close()
      await unlink(lockPath)
    }
  }
}
