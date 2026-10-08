import { searchMediaCatalogue, type CatalogueImage } from './media-catalogue.js'
export class MediaPicker {
  readonly #dialog = document.createElement('dialog')
  readonly #query = document.createElement('input')
  readonly #grid = document.createElement('div')
  readonly #status = document.createElement('p')
  #request?: AbortController
  #choose?: (item: CatalogueImage, signal: AbortSignal) => Promise<void>
  #return?: HTMLElement
  constructor() {
    const title = document.createElement('h2'); title.textContent = 'GIFs and stickers'
    this.#dialog.className = 'mediaPicker'; this.#dialog.setAttribute('aria-label', 'GIFs and stickers')
    const privacy = document.createElement('p'); privacy.textContent = 'Search sends your query and IP address to Wikimedia Commons. Selected files are encrypted before sharing.'
    const form = document.createElement('form'); const mode = document.createElement('select'); mode.setAttribute('aria-label', 'Media type')
    for (const [value, label] of [['gifs', 'Animated GIFs'], ['stickers', 'Sticker images']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; mode.append(option) }
    this.#query.type = 'search'; this.#query.maxLength = 80; this.#query.setAttribute('aria-label', 'Search GIFs and stickers'); this.#query.placeholder = 'Try cats, celebration, rocket…'
    const search = document.createElement('button'); search.type = 'submit'; search.textContent = 'Search catalogue'
    form.append(mode, this.#query, search); this.#grid.className = 'mediaGrid'; this.#status.setAttribute('role', 'status')
    form.addEventListener('submit', async event => {
      event.preventDefault(); this.#request?.abort(); const request = this.#request = new AbortController()
      this.#grid.replaceChildren(); this.#status.textContent = 'Searching…'; search.disabled = true
      try {
        const items = await searchMediaCatalogue(this.#query.value || 'celebration', mode.value === 'stickers', request.signal)
        if (this.#request !== request) return
        this.#status.textContent = items.length ? 'Choose a file to add to your message.' : 'No matching files. Try another search.'
        for (const item of items) {
          const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-label', `Add ${item.name}`)
          const image = document.createElement('img'); image.src = item.url; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'
          const name = document.createElement('span'); name.textContent = item.name
          const credit = document.createElement('small'); credit.textContent = item.credit
          button.append(image, name, credit)
          button.onclick = async () => {
            button.disabled = true; this.#status.textContent = 'Adding encrypted file…'
            try { await this.#choose?.(item, request.signal); this.#dialog.close() }
            catch (error) { if (!request.signal.aborted) this.#status.textContent = error instanceof Error ? error.message : 'Could not add this file.' }
            finally { button.disabled = false }
          }
          this.#grid.append(button)
        }
      } catch (error) { if (!request.signal.aborted) this.#status.textContent = error instanceof Error ? error.message : 'The catalogue could not be reached.' }
      finally { if (this.#request === request) search.disabled = false }
    })
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close media picker'; close.onclick = () => this.close()
    this.#dialog.append(title, privacy, form, this.#status, this.#grid, close); document.body.append(this.#dialog)
    this.#dialog.addEventListener('close', () => { this.#request?.abort(); this.#request = undefined; this.#choose = undefined; this.#grid.replaceChildren(); this.#return?.focus({ preventScroll: true }) })
  }
  open(anchor: HTMLElement, choose: (item: CatalogueImage, signal: AbortSignal) => Promise<void>): void { this.#return = anchor; this.#choose = choose; this.#status.textContent = ''; this.#dialog.showModal(); this.#query.focus() }
  close(): void { this.#dialog.close() }
}
