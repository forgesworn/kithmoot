import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireStateLock, StateLockHeldError } from './state-lock.js'

const dirs: string[] = []
const children: ChildProcess[] = []

function stateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kithmoot-lock-'))
  dirs.push(dir)
  return join(dir, 'room.json')
}

/** A process that is running, and is not this one. */
function liveProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  children.push(child)
  return child.pid!
}

/** The id of a process that has exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!
}

function writeLock(path: string, holder: Record<string, unknown>): void {
  writeFileSync(`${path}.lock`, JSON.stringify(holder) + '\n')
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('the keeper state lock', () => {
  it('is taken exclusively, names who holds it, and goes on a clean release', () => {
    const state = stateFile()
    const lock = acquireStateLock(state)
    expect(lock.path).toBe(`${state}.lock`)
    expect(JSON.parse(readFileSync(lock.path, 'utf8'))).toMatchObject({ pid: process.pid, host: hostname() })
    // The same process asking twice is refused as well.
    expect(() => acquireStateLock(state)).toThrow(StateLockHeldError)
    lock.release()
    expect(existsSync(lock.path)).toBe(false)
    lock.release()
    acquireStateLock(state).release()
  })

  it('refuses a second keeper while the first is running', () => {
    const state = stateFile()
    const pid = liveProcess()
    writeLock(state, { pid, host: hostname(), at: 1 })
    expect(() => acquireStateLock(state)).toThrow(new RegExp(`held by process ${pid} on ${hostname()}: another keeper is running`))
    // Not touched: it is the other keeper's.
    expect(JSON.parse(readFileSync(`${state}.lock`, 'utf8')).pid).toBe(pid)
  })

  it('takes over a lock left by a keeper that is no longer running', () => {
    const state = stateFile()
    writeLock(state, { pid: deadPid(), host: hostname(), at: 1 })
    const lock = acquireStateLock(state)
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid)
    lock.release()
  })

  it('takes over a lock from before a reboot, whatever process has that id now', () => {
    const state = stateFile()
    const pid = liveProcess()
    writeLock(state, { pid, host: hostname(), boot: 'before', at: 1 })
    acquireStateLock(state, { boot: 'after' }).release()
  })

  it('takes over a lock naming this process id when this process does not hold it: a restarted container', () => {
    const state = stateFile()
    writeLock(state, { pid: 1, host: hostname(), at: 1 })
    acquireStateLock(state, { pid: 1, alive: () => true }).release()
  })

  it('never takes over a lock from another host', () => {
    const state = stateFile()
    writeLock(state, { pid: deadPid(), host: 'elsewhere', at: 1 })
    expect(() => acquireStateLock(state)).toThrow(/held by process \d+ on elsewhere.*If no keeper is running on that host/)
  })

  it('takes over an unreadable lock only once it is old', () => {
    const state = stateFile()
    writeFileSync(`${state}.lock`, '')
    expect(() => acquireStateLock(state)).toThrow(/cannot be read/)
    const old = new Date(Date.now() - 120_000)
    utimesSync(`${state}.lock`, old, old)
    acquireStateLock(state).release()
  })

  it('does not remove a lock somebody else has taken since', () => {
    const state = stateFile()
    const lock = acquireStateLock(state)
    writeLock(state, { pid: 4242, host: 'elsewhere', at: 2 })
    lock.release()
    expect(existsSync(`${state}.lock`)).toBe(true)
  })

  it('kithmoot-agent create refuses to start on a state file another keeper holds', async () => {
    const { main } = await import('./cli.js')
    const state = stateFile()
    const pid = liveProcess()
    writeLock(state, { pid, host: hostname(), at: 1 })
    const stderr: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    await expect(main(['create', '--base', 'https://example.test/j/', '--name', 'Keeper', '--state', state, '--quiet'])).rejects.toThrow('exit 2')
    expect(stderr.join('')).toMatch(new RegExp(`room\\.json\\.lock is held by process ${pid}`))
    // It stopped before reading or writing anything of the room's.
    expect(existsSync(state)).toBe(false)
    expect(existsSync(`${state}.link`)).toBe(false)
  })
})
