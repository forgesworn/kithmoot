/** Pending and failed sends belong to their original conversation. Retrying
 * uses the prepared event, never the currently selected channel or draft. */
export class Outbox {
  readonly #root: HTMLElement
  readonly #items = new Set<HTMLElement>()

  constructor(root: HTMLElement) {
    this.#root = root
  }

  get pending(): boolean { return this.#items.size > 0 }

  send(text: string, channel: string, publish: () => Promise<void>, files: string[] = []): void {
    const row = document.createElement('div')
    row.className = 'outboxItem'
    const caption = document.createElement('p')
    caption.textContent = `${channel}: ${text}${files.length ? ` — ${files.join(', ')}` : ''}`
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = 'Retry'
    const discard = document.createElement('button')
    discard.type = 'button'
    discard.textContent = 'Dismiss'
    const remove = () => {
      this.#items.delete(row)
      row.remove()
      this.#root.hidden = !this.pending
    }
    discard.addEventListener('click', () => {
      if (confirm('Dismiss this unsent message? A relay may have received it even if its acknowledgement did not arrive.')) remove()
    })
    const attempt = async () => {
      retry.hidden = discard.hidden = true
      status.textContent = 'Sending…'
      try {
        await publish()
        remove()
      } catch (error) {
        status.textContent = `Send not confirmed. ${error instanceof Error ? error.message : String(error)}`
        retry.hidden = discard.hidden = false
      }
    }
    retry.addEventListener('click', () => { void attempt() })
    row.append(caption, status, retry, discard)
    this.#items.add(row)
    this.#root.append(row)
    this.#root.hidden = false
    void attempt()
  }
}
