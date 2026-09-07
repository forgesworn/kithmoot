export interface ConfirmActionOptions {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  /** Do not authorise an action if its room or account changed while waiting. */
  isCurrent?: () => boolean
}

let pending = Promise.resolve()

/** App-owned confirmations keep the room running and never block incoming
 * messages or media. Only one confirmation is shown at a time. */
export function confirmAction(options: ConfirmActionOptions): Promise<boolean> {
  const result = pending.then(() => showConfirmation(options))
  pending = result.then(() => {}, () => {})
  return result
}

function showConfirmation(options: ConfirmActionOptions): Promise<boolean> {
  if (options.isCurrent?.() === false) return Promise.resolve(false)
  const opener = document.activeElement as HTMLElement | null
  const message = opener?.closest<HTMLElement>('[data-message-id]')
  const dialog = document.createElement('dialog')
  dialog.id = 'actionDialog'
  dialog.className = 'actionDialog'
  dialog.setAttribute('role', 'alertdialog')
  dialog.setAttribute('aria-labelledby', 'actionTitle')
  dialog.setAttribute('aria-describedby', 'actionDescription')
  const title = document.createElement('h2')
  title.id = 'actionTitle'
  title.textContent = options.title
  const description = document.createElement('p')
  description.id = 'actionDescription'
  description.textContent = options.message
  const actions = document.createElement('form')
  actions.className = 'actionDialogButtons'
  const cancel = document.createElement('button')
  cancel.id = 'actionCancel'
  cancel.type = 'button'
  cancel.textContent = options.cancelLabel ?? 'Cancel'
  cancel.autofocus = true
  const confirm = document.createElement('button')
  confirm.id = 'actionConfirm'
  confirm.type = 'submit'
  confirm.className = options.danger ? 'danger' : 'primary'
  confirm.textContent = options.confirmLabel
  actions.append(cancel, confirm)
  dialog.append(title, description, actions)
  document.body.append(dialog)
  return new Promise(resolve => {
    const cancelForDeparture = () => dialog.close('cancel')
    window.addEventListener('pagehide', cancelForDeparture, { once: true })
    dialog.addEventListener('close', () => {
      const approved = dialog.returnValue === 'confirm' && options.isCurrent?.() !== false
      window.removeEventListener('pagehide', cancelForDeparture)
      dialog.remove()
      const replacementMessage = message && Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find(element => element.dataset.messageId === message.dataset.messageId && element.dataset.messageAuthor === message.dataset.messageAuthor)
      const replacement = replacementMessage && Array.from(replacementMessage.querySelectorAll<HTMLElement>('[data-focus-key]'))
        .find(element => element.dataset.focusKey === opener?.dataset.focusKey)
      const target = opener?.isConnected && opener.getClientRects().length ? opener : replacement
        ?? document.querySelector<HTMLElement>('dialog[open] button')
        ?? Array.from(document.querySelectorAll<HTMLElement>('#roomMenu, #homeRoomQuery')).find(element => element.getClientRects().length)
      target?.focus({ preventScroll: true })
      document.dispatchEvent(new Event('kithmoot:confirmation-closed'))
      resolve(approved)
    }, { once: true })
    cancel.addEventListener('click', () => dialog.close('cancel'))
    actions.addEventListener('submit', event => { event.preventDefault(); dialog.close('confirm') })
    // Some browser keyboard settings skip buttons in the default tab order.
    // Keep both decisions reachable inside this two-action dialog.
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      ;(document.activeElement === cancel ? confirm : cancel).focus({ preventScroll: true })
    })
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return
      const bounds = dialog.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close('cancel')
    })
    dialog.showModal()
    cancel.focus({ preventScroll: true })
  })
}
