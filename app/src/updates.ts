import { registerSW } from 'virtual:pwa-register'

/** Activation can finish without controllerchange on an uncontrolled first
 * visit. Observe the worker itself, and never leave a failed attempt pending. */
function activateUpdate(registration: ServiceWorkerRegistration): Promise<void> {
  // active can still be activating, or already activated by another tab.
  const worker = registration.waiting ?? registration.installing ?? registration.active
  if (!worker) return Promise.reject(new Error('No update is ready'))
  return new Promise((resolve, reject) => {
    let requested = false
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      worker.removeEventListener('statechange', changed)
      if (error) reject(error)
      else resolve()
    }
    const changed = () => {
      if (worker.state === 'activated') finish()
      else if (worker.state === 'redundant') finish(new Error('Update became redundant'))
      else if (worker.state === 'installed' && !requested) {
        requested = true
        try { worker.postMessage({ type: 'SKIP_WAITING' }) }
        catch { finish(new Error('Could not activate update')) }
      }
    }
    const timeout = setTimeout(() => finish(new Error('Update timed out')), 10_000)
    worker.addEventListener('statechange', changed)
    changed()
  })
}

/** Other tabs can activate a worker too. None may reload this page without
 * this user's consent, even when migrating from an auto-update worker. */
export function installUpdates(blockedReason: () => string | undefined, reload: () => void = () => location.reload()): void {
  const notice = document.getElementById('updateNotice')!
  const button = document.getElementById('updateApp') as HTMLButtonElement
  let activated = false
  let approved = false
  let reloading = false
  let registration: ServiceWorkerRegistration | undefined
  const defer = (reason: string) => {
    approved = false
    button.disabled = false
    button.textContent = 'Update now'
    notice.querySelector('span')!.textContent = reason
    notice.hidden = false
  }
  const reloadOnce = () => {
    if (reloading) return
    // Activation is asynchronous: consent cannot discard work started while
    // the worker was installing, or end a call that has since started.
    const reason = blockedReason()
    if (reason) { defer(reason); return }
    reloading = true
    approved = false
    reload()
  }
  registerSW({
    immediate: true,
    onNeedRefresh: () => { notice.hidden = false },
    onNeedReload: () => {
      activated = true
      if (approved) reloadOnce()
      else notice.hidden = false
    },
    onRegisteredSW: (_url, registered) => {
      if (!registered) return
      registration = registered
      let checking = false
      const check = async () => {
        if (checking || document.visibilityState !== 'visible' || !navigator.onLine) return
        // A pending worker already represents an update. Let onNeedRefresh
        // reveal it, including when one was already waiting on load.
        if (registered.waiting || registered.installing) return
        checking = true
        try {
          await registered.update()
        } catch {
          // Keep the current app usable offline and retry on the next check.
        } finally {
          checking = false
        }
      }
      // An installed PWA can stay open for days without a navigation. Check
      // during use and on return; registering once does not detect a deploy.
      window.setInterval(check, 60_000)
      window.addEventListener('focus', check)
      window.addEventListener('pageshow', check)
      window.addEventListener('online', check)
      document.addEventListener('visibilitychange', check)
      void check()
    },
  })
  button.addEventListener('click', async () => {
    if (approved || reloading) return
    const reason = blockedReason()
    if (reason) { defer(reason); return }
    approved = true
    button.disabled = true
    button.textContent = 'Updating…'
    try {
      if (registration) await activateUpdate(registration)
      else if (!activated) throw new Error('Registration is not ready')
      if (approved) reloadOnce()
    } catch {
      if (reloading) return
      approved = false
      button.disabled = false
      button.textContent = 'Try updating again'
      notice.querySelector('span')!.textContent = 'The update did not finish. Try again.'
    }
  })
}
