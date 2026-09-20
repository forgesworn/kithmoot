export const UPDATE_FEED = 'https://kithmoot.forgesworn.dev/downloads/updates/darwin/arm64/RELEASES.json'

const genericError = 'Could not check for updates. KithMoot will try again.'

export function createDesktopUpdater({
  autoUpdater,
  platform,
  arch,
  packaged,
  notify = () => {},
  log = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  initialDelayMs = 30_000,
  intervalMs = 10 * 60_000,
}) {
  const enabled = packaged && platform === 'darwin' && arch === 'arm64'
  let current = { phase: enabled ? 'idle' : 'disabled' }
  let started = false
  let initialTimer
  let intervalTimer
  let installRequested = false

  const state = () => ({ ...current })
  const transition = (phase, details = {}) => {
    current = { phase, ...details }
    notify(state())
  }
  const clearTimers = () => {
    if (initialTimer !== undefined) clearTimeoutFn(initialTimer)
    if (intervalTimer !== undefined) clearIntervalFn(intervalTimer)
    initialTimer = intervalTimer = undefined
  }
  const fail = error => {
    if (current.phase === 'ready' || current.phase === 'error') return
    log(error instanceof Error ? error : new Error('Unknown updater error'))
    transition('error', { message: genericError })
  }
  const check = () => {
    if (!enabled || !started || ['checking', 'downloading', 'ready'].includes(current.phase)) return false
    transition('checking')
    let result
    try { result = autoUpdater.checkForUpdates() }
    catch (error) { fail(error); return false }
    Promise.resolve(result).catch(fail)
    return true
  }
  const install = () => {
    if (current.phase !== 'ready' || installRequested) return false
    installRequested = true
    try { autoUpdater.quitAndInstall() }
    catch (error) {
      installRequested = false
      log(error instanceof Error ? error : new Error('Unknown updater install error'))
      transition('error', { message: 'The update could not restart KithMoot. Try again.' })
      return false
    }
    return true
  }
  const start = () => {
    if (!enabled || started) return false
    started = true
    try { autoUpdater.setFeedURL({ url: UPDATE_FEED, serverType: 'json' }) }
    catch (error) { started = false; fail(error); return false }
    autoUpdater.on('checking-for-update', () => transition('checking'))
    autoUpdater.on('update-available', () => transition('downloading'))
    autoUpdater.on('update-not-available', () => { if (current.phase !== 'ready') transition('idle') })
    autoUpdater.on('error', fail)
    autoUpdater.on('update-downloaded', (_event, _notes, releaseName) => {
      if (current.phase === 'ready') return
      clearTimers()
      const version = typeof releaseName === 'string' ? releaseName.trim() : ''
      transition('ready', version ? { version } : {})
    })
    transition('idle')
    initialTimer = setTimeoutFn(() => {
      initialTimer = undefined
      check()
      if (current.phase !== 'ready') intervalTimer = setIntervalFn(check, intervalMs)
    }, initialDelayMs)
    return true
  }

  return Object.freeze({ start, check, install, state })
}
