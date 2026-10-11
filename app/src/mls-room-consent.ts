import { BrowserMlsRoomForeground, type MlsRoomForegroundScope } from './mls-room-foreground.js'
import { scopeShape, type ConsentScope, type ConsentDecision } from './mls-vault.js'

/** Concrete private room prompt. No caller promise or event-signing request
 * crosses the UI boundary. Cancellation settles to denial synchronously;
 * the tracked vault still owns its subsequent actual journal/cleanup work. */
export class BrowserMlsRoomConsent {
  #cancel?: () => void
  constructor(private readonly root: Document = document) {}
  cancel(): void { this.#cancel?.() }
  ask(foreground: BrowserMlsRoomForeground, scope: MlsRoomForegroundScope, permission: ConsentScope,
    deadline: number, current: () => boolean): Promise<ConsentDecision> {
    if (!(foreground instanceof BrowserMlsRoomForeground) || !foreground.active(scope) || !scopeShape(permission) ||
        permission.persona !== scope.account || !Number.isSafeInteger(deadline)) return Promise.resolve('deny')
    const now = Math.floor(Date.now() / 1000), budget = deadline - now
    if (budget < 0 || budget > 600 || this.#cancel) return Promise.resolve('deny')
    const start = performance.now()
    const live = () => {
      try { return foreground.active(scope) && current() && this.root.visibilityState === 'visible' &&
        Math.floor(Date.now() / 1000) <= deadline && performance.now() - start <= (budget + 1) * 1000 } catch { return false }
    }
    if (!live()) return Promise.resolve('deny')
    return new Promise<ConsentDecision>(resolve => {
      const dialog = this.root.createElement('dialog')
      dialog.id = 'mlsRoomConsent'; dialog.className = 'profileSettings'
      dialog.setAttribute('aria-labelledby', 'mlsRoomConsentTitle')
      const title = this.root.createElement('h2'); title.id = 'mlsRoomConsentTitle'; title.textContent = 'Allow this room permission?'
      const text = this.root.createElement('p'); text.style.whiteSpace = 'pre-wrap'
      text.textContent = `App: ${permission.principal}\nAccount: ${permission.persona}\nDevice: ${permission.device}\nBothy: ${permission.homeBox}\nPermission: ${permission.method === 'signBoxRequestV1/1' ? 'Authenticate contracted MLS requests' : 'Sign MLS leaf bindings'}\n\nApproval is saved with the witness. Withdraw it in MLS witness settings.`
      const approve = this.root.createElement('button'); approve.type = 'button'; approve.textContent = 'Allow'; approve.dataset.approve = ''
      const deny = this.root.createElement('button'); deny.type = 'button'; deny.textContent = 'Deny'; deny.dataset.deny = ''
      dialog.append(title, text, approve, deny)
      let ended = false, timer: ReturnType<typeof setTimeout> | undefined
      const finish = (decision: ConsentDecision) => {
        if (ended) return
        ended = true
        if (timer !== undefined) clearTimeout(timer)
        scope.signal.removeEventListener('abort', cancel)
        this.root.removeEventListener('visibilitychange', visibility)
        if (this.#cancel === cancel) this.#cancel = undefined
        const accepted = decision === 'approve' && live() ? 'approve' : 'deny'
        if (dialog.open) dialog.close()
        dialog.remove(); resolve(accepted)
      }
      const cancel = () => finish('deny')
      const visibility = () => { if (this.root.visibilityState !== 'visible') cancel() }
      const check = () => { if (!live()) cancel(); else timer = setTimeout(check, 100) }
      this.#cancel = cancel
      scope.signal.addEventListener('abort', cancel, { once: true })
      this.root.addEventListener('visibilitychange', visibility)
      approve.onclick = () => finish('approve'); deny.onclick = cancel
      dialog.addEventListener('cancel', event => { event.preventDefault(); cancel() })
      dialog.addEventListener('close', cancel)
      try { this.root.body.append(dialog); if (!live()) cancel(); else { dialog.showModal(); check() } }
      catch { cancel() }
    })
  }
}
