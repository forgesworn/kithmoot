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
  })
  button.addEventListener('click', async () => {
    if (hasWork() && !confirm('Reload to update? This ends your call and discards any unsent messages and files.')) return
    approved = true
    if (activated) {
      reload()
      return
    }
    button.disabled = true
    try {
      await update()
    } catch {
      approved = false
      button.disabled = false
      button.textContent = 'Try updating again'
    }
  })
}
