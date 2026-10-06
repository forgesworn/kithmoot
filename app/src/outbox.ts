import { confirmAction } from './confirm-action.js'
import { neverLeft, type PendingSend, type PendingSends } from './pending-sends.js'

/**
 * Shows this device's unsent messages at the foot of the conversation, as
 * its own messages, each saying what it is waiting for. The state lives in
 * `PendingSends`; this only draws it. Rows belong to the room they were
 * written in, never the one on screen when they are retried.
 */
export class Outbox {
  readonly #root: HTMLElement

  /** `sending` is what a row says while its publish is in flight: a relay
   *  takes an ordinary message in a moment, a quiet room's at its next slot,
   *  and the row should say which it is waiting for. */
  /** `edit` takes a message back into the message box; `canEdit` says
   *  whether that box is the one for the message's conversation. */
  constructor(root: HTMLElement, private readonly queue: PendingSends, private readonly room: () => string | undefined,
    private readonly sending: () => string = () => 'Sending…',
    private readonly edit?: (item: PendingSend) => void | Promise<void>, private readonly canEdit: (item: PendingSend) => boolean = () => false) {
    this.#root = root
  }

  /** Unsent messages a reload would lose: those not kept on this device,
   *  and any on their way out, whose outcome a reload cannot learn. */
  get pending(): boolean { return this.queue.items().some(item => !item.acknowledged && (!item.durable || item.state === 'sending')) }

  render(): void {
    const roomId = this.room()
    const items = roomId ? this.queue.items(roomId) : []
    // Keep the focus on a button that survives a redraw.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-pending-id]')
    const focusedId = focused?.dataset.pendingId
    const focusedAction = (document.activeElement as HTMLElement | null)?.dataset.action
    this.#root.replaceChildren(...items.map(item => this.#row(item)))
    this.#root.hidden = items.length === 0
    if (focusedId && focusedAction) this.#root.querySelector<HTMLElement>(`[data-pending-id="${focusedId}"] [data-action="${focusedAction}"]`)?.focus()
  }

  #row(item: PendingSend): HTMLElement {
    const row = document.createElement('div')
    row.className = 'msg mine pendingMsg'
    row.dataset.pendingId = item.id
    row.dataset.state = item.acknowledged ? 'sent' : item.state
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const text = document.createElement('p')
    text.className = 'pendingText'
    text.textContent = item.text
    bubble.append(text)
    if (item.files.length) {
      const files = document.createElement('p')
      files.className = 'pendingFiles'
      files.textContent = item.files.join(', ')
      bubble.append(files)
    }
    const status = document.createElement('p')
    status.className = 'pendingStatus'
    status.setAttribute('role', 'status')
    status.textContent = this.#status(item)
    row.append(bubble, status)
    const actions = document.createElement('div')
    actions.className = 'pendingActions'
    if (!item.acknowledged && (item.state === 'waiting' || item.state === 'refused' || item.state === 'unknown') && item.publish) {
      actions.append(this.#button('Retry', 'retry', () => this.queue.retry(item.id)))
    }
    // Edit and Delete only where nothing has left this device, so neither
    // leaves a trace. One that may have arrived can only leave this list.
    if (this.edit && item.editable && neverLeft(item) && this.canEdit(item)) {
      actions.append(this.#button('Edit', 'edit', () => this.edit!(item)))
    }
    if (!item.acknowledged && item.state !== 'sending') {
      const clean = neverLeft(item)
      actions.append(this.#button(clean ? 'Delete' : 'Remove from list', 'remove', async () => {
        if (await confirmAction({ ...this.#removal(item), confirmLabel: clean ? 'Delete message' : 'Remove from list', danger: true, isCurrent: () => row.isConnected })) this.queue.dismiss(item.id)
      }))
    }
    if (actions.childElementCount) row.append(actions)
    return row
  }

  #status(item: PendingSend): string {
    if (item.acknowledged) return 'Sent'
    const where = item.channel === 'Chat' ? '' : ` in ${item.channel}`
    switch (item.state) {
      case 'sending': return this.sending()
      case 'waiting': return item.attempts ? `Pending${where}: will send when a relay answers.` : `Pending${where}: will send when you are connected.`
      case 'refused': return `Not sent${where}: the relays turned it down. Trying again shortly.`
      case 'unknown': return `Not confirmed${where}: no relay answered in time. Trying again shortly.`
      case 'moved': return `Not sent${where}: this conversation changed its key before it went. Copy it into the conversation to send it.`
    }
  }

  /** What removing a row can promise depends on whether it ever left. */
  #removal(item: PendingSend): { title: string; message: string } {
    if (!neverLeft(item)) return {
      title: 'Remove this message from the list?',
      message: 'A relay may have received it even if its acknowledgement did not arrive, so people may still see it. Removing it only takes it off this list.',
    }
    return {
      title: 'Delete this unsent message?',
      message: 'It has not reached any relay, so nobody will see it.',
    }
  }

  #button(label: string, action: string, run: () => void | Promise<void>): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.dataset.action = action
    button.addEventListener('click', () => { void run() })
    return button
  }
}
