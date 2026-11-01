import { confirmAction } from './confirm-action.js'
import { neverLeft, pastAutoRetryLimit, type PendingSend, type PendingSends } from './pending-sends.js'
import { artworkCards, artworkMessageText } from './chat-artwork.js'
import { GROUP_STORAGE_WAITING } from '../../src/group-storage.js'

/**
 * Shows this device's unsent messages at the foot of the conversation, as
 * its own messages, each saying what it is waiting for. The state lives in
 * `PendingSends`; this only draws it. Rows belong to the room they were
 * written in, never the one on screen when they are retried.
 */
export class Outbox {
  readonly #root: HTMLElement
  #roomId?: string
  #ids = new Set<string>()
  #modelKey?: string

  /** `sending` is what a row says while its publish is in flight: a relay
   *  takes an ordinary message in a moment, a quiet room's at its next slot,
   *  and the row should say which it is waiting for. */
  /** `edit` takes a message back into the message box; `canEdit` says
   *  whether that box is the one for the message's conversation. */
  constructor(root: HTMLElement, private readonly queue: PendingSends, private readonly room: () => string | undefined,
    private readonly sending: () => string = () => 'Sending…',
    private readonly edit?: (item: PendingSend) => void | Promise<void>, private readonly canEdit: (item: PendingSend) => boolean = () => false,
    /** A message that cannot leave before its room self-destructs, and
     *  what its row says then. */
    private readonly doomed: (item: PendingSend) => boolean = () => false, private readonly doomedText = 'Will not be sent',
    /** Stops a message's upload to the group's storage that is in flight, so the row can be deleted. True when it stopped; false when the message has already begun to go out. */
    private readonly stopUpload: (item: PendingSend) => Promise<boolean> = async () => false) {
    this.#root = root
  }

  /** Unsent messages a reload would lose: those not kept on this device,
   *  and any on their way out, whose outcome a reload cannot learn. */
  get pending(): boolean { return this.queue.items().some(item => !item.acknowledged && (!item.durable || item.state === 'sending')) }

  /** The same, without the messages that wait for a group's storage. Those can
   *  wait for days (a keeper that is away), so they do not hold a person in a
   *  room: leaving asks first (`waitingOnStorage`). */
  get blocking(): boolean { return this.queue.items().some(item => !item.acknowledged && (!item.durable || item.state === 'sending') && !item.storage) }

  /** Whether this room has a message waiting for the group's storage, which leaving the room would lose with its files. */
  get waitingOnStorage(): boolean {
    const roomId = this.room()
    return !!roomId && this.queue.items(roomId).some(item => !item.acknowledged && item.storage === true)
  }

  render(): void {
    const roomId = this.room()
    const items = roomId ? this.queue.items(roomId) : []
    // A countdown changes the status text, not the message or its controls.
    // Detaching a pressed button between pointer-down and pointer-up can lose
    // Undo/Send now entirely, even when focus is restored to its replacement.
    // Include every presentation field and permission; event bytes are already
    // identified by their signed id and do not need serialising on each tick.
    const now = Date.now()
    const modelKey = JSON.stringify([roomId, items.map(item => {
      const { event, ...presentation } = item
      return [presentation, event.id, this.canEdit(item), this.doomed(item), pastAutoRetryLimit(item, now)]
    })])
    if (modelKey === this.#modelKey && this.#root.children.length === items.length &&
      items.every((item, index) => this.#root.children[index]?.getAttribute('data-pending-id') === item.id)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        const status = this.#root.children[i]?.querySelector('.pendingStatus')
        const text = this.doomed(item) ? this.doomedText : this.#status(item)
        if (status && status.textContent !== text) status.textContent = text
      }
      this.#root.hidden = items.length === 0
      return
    }
    const added = roomId !== this.#roomId || items.some(item => !this.#ids.has(item.id))
    const scrollTop = this.#root.scrollTop
    const follow = this.#root.scrollHeight - this.#root.clientHeight - scrollTop < 48
    this.#roomId = roomId
    this.#ids = new Set(items.map(item => item.id))
    // Keep the focus on a button that survives a redraw.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-pending-id]')
    const focusedId = focused?.dataset.pendingId
    const focusedAction = (document.activeElement as HTMLElement | null)?.dataset.action
    this.#root.replaceChildren(...items.map(item => this.#row(item)))
    this.#root.hidden = items.length === 0
    // Sending must show the new row even when older pending messages fill
    // this scrollbox. Status-only redraws preserve someone reading above it.
    this.#root.scrollTop = added || follow ? this.#root.scrollHeight : scrollTop
    if (focusedId && focusedAction) this.#root.querySelector<HTMLElement>(`[data-pending-id="${focusedId}"] [data-action="${focusedAction}"]`)?.focus()
    this.#modelKey = modelKey
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
    text.textContent = artworkMessageText(item.text, item.artwork)
    text.hidden = !text.textContent
    bubble.append(text)
    bubble.append(artworkCards(item.artwork, undefined, item.text))
    if (item.files.length) {
      const files = document.createElement('p')
      files.className = 'pendingFiles'
      files.textContent = item.files.join(', ')
      bubble.append(files)
    }
    const status = document.createElement('p')
    status.className = 'pendingStatus'
    // A countdown read out every second would drown everything else.
    if (item.state !== 'holding') status.setAttribute('role', 'status')
    const doomed = this.doomed(item)
    status.textContent = doomed ? this.doomedText : this.#status(item)
    if (doomed) row.dataset.state = 'doomed'
    row.append(bubble, status)
    if (doomed) return row
    const actions = document.createElement('div')
    actions.className = 'pendingActions'
    if (item.state === 'holding') {
      // Undo takes it back as it was: into the message box when it can go
      // back there, otherwise simply not sent.
      actions.append(this.#button('Undo', 'undo', () => {
        if (this.edit && item.editable && this.canEdit(item)) return this.edit(item)
        return this.queue.take(item.id).then(() => {})
      }), this.#button('Send now', 'send-now', () => this.queue.retry(item.id)))
      row.append(actions)
      return row
    }
    // Past a day Retry signs it again as a new message, so it is offered only where that can be done.
    if (!item.acknowledged && (item.state === 'waiting' || item.state === 'refused' || item.state === 'unknown') &&
      (pastAutoRetryLimit(item, Date.now()) ? item.renewable : item.ready)) {
      actions.append(this.#button('Retry', 'retry', () => this.queue.retry(item.id)))
    }
    // Edit and Delete only where nothing has left this device, so neither
    // leaves a trace. One that may have arrived can only leave this list.
    if (this.edit && item.editable && neverLeft(item) && this.canEdit(item)) {
      actions.append(this.#button('Edit', 'edit', () => this.edit!(item)))
    }
    // A message whose files are still going up can be stopped and deleted: nothing of it has left until its files are on a node.
    const uploading = item.state === 'sending' && item.storage === true
    if (!item.acknowledged && (item.state !== 'sending' || uploading)) {
      const clean = neverLeft(item) || uploading
      actions.append(this.#button(clean ? 'Delete' : 'Remove from list', 'remove', async () => {
        if (!await confirmAction({ ...this.#removal(item, clean), confirmLabel: clean ? 'Delete message' : 'Remove from list', danger: true, isCurrent: () => row.isConnected })) return
        const live = this.queue.items(item.roomId).find(saved => saved.id === item.id)
        if (live?.state === 'sending') {
          if (!await this.stopUpload(live)) {
            // Its files are on a node and it has begun to go out: too late to take back.
            const status = row.querySelector('.pendingStatus')
            if (status) status.textContent = 'It is already being sent.'
            return
          }
          await this.queue.settled(item.id)
        }
        await this.queue.dismiss(item.id)
      }))
    }
    if (actions.childElementCount) row.append(actions)
    return row
  }

  #status(item: PendingSend): string {
    return pendingStatusWords(item, this.sending(), Date.now())
  }

  /** What removing a row can promise depends on whether it ever left. */
  #removal(item: PendingSend, clean = neverLeft(item)): { title: string; message: string } {
    if (!clean) return {
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
    button.addEventListener('click', () => {
      button.disabled = true
      void Promise.resolve().then(run).catch(() => {
        const status = button.closest('[data-pending-id]')?.querySelector('.pendingStatus')
        if (status) status.textContent = 'Could not save this change. Your message is still held. Try again.'
      }).finally(() => { button.disabled = false })
    })
    return button
  }
}

/** What a row says about its message: pure, so every state's words can be checked without a page. `sending` is what a row says while its publish is in flight. */
export function pendingStatusWords(item: PendingSend, sending: string, now: number): string {
  // A relay saying OK is not the message being kept; the chat row's tick says that once it has the evidence.
  if (item.acknowledged) return sending
  if (item.held) return 'Message held: could not save its state. Retry when storage is available.'
  const where = item.channel === 'Chat' ? '' : ` in ${item.channel}`
  switch (item.state) {
    case 'holding': {
      const seconds = Math.max(1, Math.ceil(((item.holdUntil ?? now) - now) / 1000))
      return `Sending in ${seconds} s${where}`
    }
    case 'sending': return sending
  }
  // Past a day it is not sent by itself any more; Retry, where offered, sends it as a new message.
  if (item.state !== 'moved' && pastAutoRetryLimit(item, now)) {
    if (!item.renewable) return item.files.length
      ? `Not sent${where}: it waited more than a day. Copy its text into the conversation to send it, and add its files again.`
      : `Not sent${where}: it waited more than a day. Copy it into the conversation to send it.`
    return item.state === 'unknown'
      ? `Not confirmed${where}: no relay answered, and it is now more than a day old. Press Retry to send it again.`
      : `Not sent${where}: it waited more than a day. Press Retry to send it now.`
  }
  switch (item.state) {
    case 'waiting':
      // A storage problem waiting will not mend says so in its own words; otherwise a message that has tried and has files for the group's storage is waiting for that.
      if (item.storage && item.stuck) return item.stuck
      if (item.storage && item.attempts) return GROUP_STORAGE_WAITING
      return item.attempts ? `Pending${where}: will send when a relay answers.` : `Pending${where}: will send when you are connected.`
    case 'refused': return item.gaveUp ? `Not sent${where}: the relays turned it down. Press Retry to try again.` : `Not sent${where}: the relays turned it down. Trying again shortly.`
    case 'unknown': return item.gaveUp ? `Not confirmed${where}: no relay answered in time. Press Retry to try again.` : `Not confirmed${where}: no relay answered in time. Trying again shortly.`
    // Its files were put aside with it, and Edit does not offer to take a message with files back: copying its words carries no file.
    case 'moved': return item.files.length
      ? `Not sent${where}: this conversation changed its key before it went. Copy its text into the conversation to send it, and add its files again.`
      : `Not sent${where}: this conversation changed its key before it went. Copy it into the conversation to send it.`
  }
}
