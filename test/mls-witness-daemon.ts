import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, access, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** A real bothyd process and keeper CLI, always in a fresh private directory.
 * Pairing capabilities stay in memory; no stdout, trace or report contains one. */
export async function witnessDaemon(binary: string, relay: string) {
  const work = await mkdtemp(join(tmpdir(), 'browser-witness-'))
  await writeFile(join(work, 'empty.toml'), '')
  await mkdir(join(work, 'ctl'), { mode: 0o700 })
  const base = ['--config', join(work, 'empty.toml'), '--data-dir', join(work, 'data'),
    '--link-relay', relay, '--role', 'shelter', '--pool-bytes', '1073741824',
    '--loopback-enabled', 'false', '--nostr-relay', 'ws://127.0.0.1:9', '--no-direct', '--log-level', 'error']
  let witness: string[] = [], child: ChildProcess | undefined, spawnFailed = false
  const exited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null
  async function stop() {
    if (!child?.pid || exited(child)) return
    const p = child, done = new Promise<void>(r => p.once('exit', () => r()))
    p.kill('SIGTERM')
    const timer = setTimeout(() => p.kill('SIGKILL'), 5_000)
    await done; clearTimeout(timer)
  }
  async function ready(file: string) {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (spawnFailed) throw new Error('Disposable witness could not start.')
      if (child && exited(child)) throw new Error(`Disposable witness exited (${child.exitCode}).`)
      try { await access(file); return } catch {}
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('Disposable witness did not become ready.')
  }
  function start() {
    spawnFailed = false
    child = spawn(resolve(binary), [...base, ...witness], { cwd: work, stdio: 'ignore' })
    // Spawn errors are surfaced by readiness, without logging arguments/data.
    child.on('error', () => { spawnFailed = true })
  }
  async function command(args: string[]) {
    return new Promise<string>((done, fail) => {
      const cli = spawn(resolve(binary), [...base, ...witness, 'witness', ...args], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      cli.stdout.on('data', chunk => { output += chunk })
      cli.stderr.resume()
      const timer = setTimeout(() => cli.kill('SIGKILL'), 30_000)
      cli.once('error', () => { clearTimeout(timer); fail(new Error('Witness CLI could not start.')) })
      cli.once('exit', code => { clearTimeout(timer); code === 0 ? done(output) : fail(new Error(`Witness CLI ${args[0]} failed (${code}).`)) })
    })
  }
  async function cleanup() { await stop(); await rm(work, { recursive: true, force: true }) }
  async function restart() { await stop(); await rm(join(work, 'ctl/witness.sock'), { force: true }); start(); await ready(join(work, 'ctl/witness.sock')) }
  try {
    start(); await ready(join(work, 'data/identity/link.key')); await stop()
    witness = ['--witness-dir', join(work, 'witness'), '--witness-control-socket', 'ctl/witness.sock']
    await command(['init']); start(); await ready(join(work, 'ctl/witness.sock'))
    return {
      stop, restart, cleanup,
      async backupWitness() {
        await stop()
        await cp(join(work, 'witness'), join(work, 'witness-backup'), { recursive: true })
        await restart()
      },
      async restoreWitness() {
        await stop()
        await rm(join(work, 'witness'), { recursive: true, force: true })
        await cp(join(work, 'witness-backup'), join(work, 'witness'), { recursive: true })
        await restart()
      },
      async pair() {
        const output = await command(['pair']), uri = output.match(/bothy:[^\s]+/)?.[0]
        if (!uri) throw new Error('Witness returned no pairing capability.')
        return uri
      },
      async enrol(line: string) {
        if (!/^bothyd witness enrol --subject [0-9a-f]{64} --installation [0-9a-f]{64} --writer [0-9a-f]{64} --initial-digest [0-9a-f]{64}$/.test(line)) throw new Error('Invalid keeper enrolment command.')
        await command(line.split(' ').slice(2))
      },
      async retire(subject: string) {
        if (!/^[0-9a-f]{64}$/.test(subject)) throw new Error('Invalid retired subject.')
        await command(['retire', '--subject', subject])
      },
    }
  } catch (error) { await cleanup(); throw error }
}
