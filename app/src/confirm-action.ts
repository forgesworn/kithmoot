export interface ConfirmActionOptions {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  /** Do not authorise an action if its room or account changed while waiting. */
  isCurrent?: () => boolean
}

export interface ChooseActionOptions extends ConfirmActionOptions {
  /** A lesser choice shown between Cancel and the main action. */
  alternativeLabel: string
  alternativeDanger?: boolean
}

export type ActionChoice = 'confirm' | 'alternative' | 'cancel'

let pending = Promise.resolve()

/** App-owned confirmations keep the room running and never block incoming
 * messages or media. Only one confirmation is shown at a time. */
export function confirmAction(options: ConfirmActionOptions): Promise<boolean> {
  return queue(options).then(choice => choice === 'confirm')
}

/** A confirmation with a second, lesser way forward. Escape, a click outside
 * and a change of room or account all still mean cancel. */
export function chooseAction(options: ChooseActionOptions): Promise<ActionChoice> {
  return queue(options)
}

function queue(options: ConfirmActionOptions | ChooseActionOptions): Promise<ActionChoice> {
  const result = pending.then(() => showConfirmation(options))
  pending = result.then(() => {}, () => {})
  return result
}

function showConfirmation(options: ConfirmActionOptions | ChooseActionOptions): Promise<ActionChoice> {
  if (options.isCurrent?.() === false) return Promise.resolve('cancel')
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
  const alternative = 'alternativeLabel' in options ? document.createElement('button') : undefined
  if (alternative && 'alternativeLabel' in options) {
    alternative.id = 'actionAlternative'
    alternative.type = 'button'
    alternative.className = options.alternativeDanger ? 'danger quiet' : 'quiet'
    alternative.textContent = options.alternativeLabel
  }
  const buttons = alternative ? [cancel, alternative, confirm] : [cancel, confirm]
  actions.append(...buttons)
  dialog.append(title, description, actions)
  document.body.append(dialog)
  return new Promise(resolve => {
    const cancelForDeparture = () => dialog.close('cancel')
    window.addEventListener('pagehide', cancelForDeparture, { once: true })
    dialog.addEventListener('close', () => {
      const choice: ActionChoice = options.isCurrent?.() === false ? 'cancel'
        : dialog.returnValue === 'confirm' || dialog.returnValue === 'alternative' ? dialog.returnValue : 'cancel'
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
      resolve(choice)
    }, { once: true })
    cancel.addEventListener('click', () => dialog.close('cancel'))
    alternative?.addEventListener('click', () => dialog.close('alternative'))
    actions.addEventListener('submit', event => { event.preventDefault(); dialog.close('confirm') })
    // Some browser keyboard settings skip buttons in the default tab order.
    // Keep every decision reachable inside this dialog.
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = (at + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length
      buttons[at < 0 ? 0 : next].focus({ preventScroll: true })
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
