import { execFileSync } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'

/** Stop only the app and helpers using this fixture's disposable profile. */
export async function stopIsolatedApp(app, profile) {
  if (!app) return
  if (!isAbsolute(profile) || !basename(profile).startsWith('kithmoot-')) throw new Error('Expected an isolated KithMoot test profile')
  const child = app.process()
  const closing = app.close().catch(() => {})
  let timer
  await Promise.race([closing, new Promise(resolve => { timer = setTimeout(resolve, 5000) })])
  clearTimeout(timer)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  // A network helper can retain Playwright's pipes after its parent exits.
  // Recheck the unique profile in live arguments before terminating helpers.
  if (process.platform !== 'win32') {
    for (const line of execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
      if (!line.includes(profile)) continue
      const pid = Number(line.trim().split(/\s+/, 1)[0])
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue
      try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
}
