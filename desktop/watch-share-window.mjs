import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
export function validWindowBounds(rect) {
  return rect && ['x','y','width','height'].every(key => Number.isFinite(rect[key]) && Math.abs(rect[key]) <= 100000)
    && rect.width > 0 && rect.height > 0
}
/** Watch only a main-process-recorded capture id; never accept an executable or
 * arbitrary native window id from a renderer message. All data remains local. */
export function watchShareWindow(captureId, report, { packaged = false, platform = process.platform, arch = process.arch, resources = process.resourcesPath, launch = spawn } = {}) {
  const match = /^window:(\d+):\d+$/.exec(captureId ?? '')
  if (!match || !BigInt(match[1])) { report(null); return () => {} }
  const base = packaged ? join(resources, 'window-helper')
    : fileURLToPath(new URL(`./artifacts/window-helper/${platform}-${arch}/window-helper/`, import.meta.url))
  const executable = join(base, `share-window${platform === 'win32' ? '.exe' : ''}`)
  const child = launch(executable, [match[1]], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let stopped = false, last = Date.now()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    last = Date.now()
    if (stopped) return
    try { const value = line.length < 512 ? JSON.parse(line) : null; report(validWindowBounds(value) ? value : null) }
    catch { report(null) }
  })
  const gone = () => { if (!stopped) report(null) }
  child.on('error', gone); child.on('exit', gone)
  // A suspended or hung helper must not leave marks over a window that moved.
  const stale = setInterval(() => { if (Date.now() - last > 300) report(null) }, 150)
  stale.unref?.()
  return () => { stopped = true; clearInterval(stale); lines.close(); child.kill() }
}
