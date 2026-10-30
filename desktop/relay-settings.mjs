import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The built-in call relay's own choices and counters, kept by the main
 * process beside its identity (no secrets, so not in the keychain):
 * whether to start it when KithMoot opens, and how much it relayed today
 * against the daily limit (docs/design/2026-10-28-built-in-relay.md, 1.4
 * and 1.6). Never in the page's storage, never synced.
 */

/** 5 GB a day, the design's built-in default. */
export const DAILY_LIMIT_BYTES = 5_000_000_000
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Today's date where the computer is, as YYYY-MM-DD. */
export function localDay(now = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function defaultSettings() { return { v: 1, startOnOpen: false, day: '', dayBytes: 0 } }

function valid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1 || typeof value.startOnOpen !== 'boolean'
    || typeof value.day !== 'string' || !(value.day === '' || DAY.test(value.day)) || !Number.isSafeInteger(value.dayBytes) || value.dayBytes < 0) return undefined
  return { v: 1, startOnOpen: value.startOnOpen, day: value.day, dayBytes: value.dayBytes }
}

export function createRelaySettings({ dir, random = randomBytes }) {
  const file = join(dir, 'settings.json')
  /** The saved settings, or the defaults when there are none or they cannot be read. */
  async function load() {
    try {
      const text = await readFile(file, 'utf8')
      if (text.length > 4096) return defaultSettings()
      return valid(JSON.parse(text)) ?? defaultSettings()
    } catch { return defaultSettings() }
  }
  async function save(settings) {
    const value = valid(settings)
    if (!value) throw new Error('Invalid call relay settings.')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${random(8).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)) } finally { await handle.close() }
    try { await rename(temporary, file) } catch (error) { await rm(temporary, { force: true }); throw error }
  }
  return { load, save, file }
}
