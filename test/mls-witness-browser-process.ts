import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'

/** Own the OS process so a boundary test can send SIGKILL, not page.reload.
 * The entire disposable profile is retained across fresh browser processes. */
export async function browserProcess(profile: string) {
  const child = spawn(chromium.executablePath(), [
    '--headless', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update',
    '--password-store=basic', '--use-mock-keychain', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let ended = false
  const done = new Promise<void>(r => child.once('exit', () => { ended = true; r() }))
  async function kill() {
    if (ended || !child.pid) return
    process.kill(-child.pid!, 'SIGKILL'); await done
  }
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => reject(new Error('Lab browser did not start.')), 20_000)
      child.stderr.on('data', chunk => {
        text = (text + chunk).slice(-4_000)
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
      child.once('error', () => { clearTimeout(timer); reject(new Error('Lab browser could not start.')) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Lab browser exited before ready.')) })
    })
    const browser = await chromium.connectOverCDP(endpoint), context = browser.contexts()[0]
    return { context, kill, async stop() {
      if (ended) return
      const timer = setTimeout(() => { void kill() }, 5_000)
      try { await browser.close() } finally { clearTimeout(timer); await kill() }
    } }
  } catch (error) { await kill(); throw error }
}
