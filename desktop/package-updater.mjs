import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The version stamp a Debian package installs beside the app. Its presence
 * is what says this copy is updated by the system's package manager. */
export const packageVersionFile = resourcesPath => join(resourcesPath, 'kithmoot-version')

export function readPackageVersion(file, read = readFileSync) {
  try { return read(file, 'utf8').trim() || undefined }
  catch { return undefined }
}

/**
 * Same surface as createDesktopUpdater, for a copy the package manager
 * upgrades underneath the running app. Nothing is downloaded here: once the
 * installed version differs from the one running, offer the same restart the
 * Mac updater does, which waits while a call or unsent work is in progress.
 */
export function createPackageUpdater({
  currentVersion,
  installedVersion,
  relaunch,
  notify = () => {},
  log = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = 60_000,
}) {
  let current = { phase: 'idle' }
  let interval
  let installRequested = false
  const state = () => ({ ...current })
  const check = () => {
    if (current.phase === 'ready') return false
    const version = installedVersion()
    if (!version || version === currentVersion) return false
    current = { phase: 'ready', version }
    if (interval !== undefined) clearIntervalFn(interval)
    interval = undefined
    notify(state())
    return true
  }
  const start = () => {
    if (interval !== undefined || current.phase === 'ready') return false
    if (!check()) interval = setIntervalFn(check, intervalMs)
    return true
  }
  const install = () => {
    if (current.phase !== 'ready' || installRequested) return false
    installRequested = true
    try { relaunch() }
    catch (error) {
      installRequested = false
      log(error instanceof Error ? error : new Error('Unknown restart error'))
      return false
    }
    return true
  }
  return Object.freeze({ start, check, install, state })
}
