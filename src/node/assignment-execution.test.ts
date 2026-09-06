import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { AssignmentExecutionJournal } from './assignment-execution.js'
import { openAssignmentStorage } from './assignment-storage.js'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
async function directory() { const d = await mkdtemp(join(tmpdir(), 'kithmoot-assignment-')); dirs.push(d); return d }

describe('assignment execution durability', () => {
  it('reopens a crashed writer cache without clearing its uncertain execution reservation', async () => {
    const dir = await directory(); const path = join(dir, 'cache.json')
    const source = new URL('./assignment-storage.ts', import.meta.url).href
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `import { openAssignmentStorage } from ${JSON.stringify(source)}; const store = await openAssignmentStorage(process.argv[1]); await store.save('encrypted retained state'); console.log('ready'); setInterval(() => {}, 1000);`, path], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await once(child.stdout!, 'data')
      await expect(openAssignmentStorage(path)).rejects.toThrow('locked')
      const journal = new AssignmentExecutionJournal(join(dir, 'executions')); const id = 'd'.repeat(64)
      const record = await journal.reserve(id, 1)
      await writeFile(join(journal.directory, `${id}-1.json`), JSON.stringify({ ...record, pid: child.pid }))
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
      const recovered = await openAssignmentStorage(path)
      try {
        expect(await recovered.load()).toBe('encrypted retained state')
        expect((await journal.inspect(id, 1)).process).toBe('missing')
        await expect(journal.reserve(id, 1)).rejects.toThrow('will not be restarted')
      } finally { await recovered.close() }
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  })
  it('allows only one concurrent reservation across independent worker objects', async () => {
    const dir = await directory(); const id = 'a'.repeat(64)
    const a = new AssignmentExecutionJournal(dir); const b = new AssignmentExecutionJournal(dir)
    const outcomes = await Promise.allSettled([a.reserve(id, 1), b.reserve(id, 1)])
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect((await a.inspect(id, 1)).process).toBe('live')
    expect((await stat(join(dir, `${id}-1.json`))).mode & 0o777).toBe(0o600)
  })
  it('does not restart an attempt whose original process disappeared', async () => {
    const dir = await directory(); const id = 'b'.repeat(64)
    const a = new AssignmentExecutionJournal(dir)
    const reserved = await a.reserve(id, 1)
    await writeFile(join(dir, `${id}-1.json`), JSON.stringify({ ...reserved, pid: 2147483647 }))
    expect((await a.inspect(id, 1)).process).toBe('missing')
    await expect(new AssignmentExecutionJournal(dir).reserve(id, 1)).rejects.toThrow('will not be restarted')
    expect((await a.reserve(id, 2)).attempt).toBe(2)
  })
  it('retains terminal execution state and prevents another process from changing it', async () => {
    const dir = await directory(); const id = 'c'.repeat(64)
    const a = new AssignmentExecutionJournal(dir); const r = await a.reserve(id, 1)
    await a.update(r, 'running')
    await expect(a.update({ ...r, executor: 'someone-else' }, 'stopped')).rejects.toThrow('does not own')
    await a.update(r, 'result', { request: 'result-request' })
    await expect(a.update(r, 'running')).rejects.toThrow('terminal')
    expect((await a.inspect(id, 1)).record?.resultRequest).toBe('result-request')
  })
  it('owns its cache lock and preserves pre-existing data when a second writer is refused', async () => {
    const path = join(await directory(), 'cache.json')
    const first = await openAssignmentStorage(path)
    await first.save('encrypted bytes')
    await expect(openAssignmentStorage(path)).rejects.toThrow('locked')
    expect(await readFile(path, 'utf8')).toBe('encrypted bytes')
    await first.close()
    const next = await openAssignmentStorage(path)
    expect(await next.load()).toBe('encrypted bytes')
    await next.close()
  })
})
