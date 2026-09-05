import { registerSW } from 'virtual:pwa-register'

/** Other tabs can activate a worker too. None may reload this page without
 * this user's consent, even when migrating from an auto-update worker. */
export function installUpdates(hasWork: () => boolean, reload: () => void = () => location.reload()): void {
  const notice = document.getElementById('updateNotice')!
  const button = document.getElementById('updateApp') as HTMLButtonElement
  let activated = false
  let approved = false
  const update = registerSW({
    immediate: true,
    onNeedRefresh: () => { notice.hidden = false },
    onNeedReload: () => {
      activated = true
      if (approved) reload()
      else notice.hidden = false
    },
    onRegisteredSW: (_url, registration) => {
      if (!registration) return
      let checking = false
      const check = async () => {
        if (checking || document.visibilityState !== 'visible' || !navigator.onLine) return
        // Let onNeedRefresh reveal the button once its activation handler
        // is attached, including when a worker was already waiting on load.
        if (registration.waiting || registration.installing) return
        checking = true
        try {
          await registration.update()
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
    if (hasWork() && !confirm('Reload to update? This ends your call and discards any unsent messages and files.')) return
    approved = true
    if (activated) {
      reload()
      return
    }
    button.disabled = true
    button.textContent = 'Updating…'
    try {
      await update()
    } catch {
      approved = false
      button.disabled = false
      button.textContent = 'Try updating again'
    }
  })
}
