import { CULT_EMOJIS } from '../../src/custom-emoji.js'
import { emojiGlyph } from './custom-emoji.js'
import { EMOJI_CATALOG } from '../../src/emoji-catalog.js'

/** Inserts into the selection saved when opening, preserving the current conversation's draft. */
export class EmojiPicker {
  readonly #dialog = document.createElement('dialog')
  readonly #query = document.createElement('input')
  readonly #grid = document.createElement('div')
  #choose?: (emoji: string) => void
  #return?: HTMLElement
  constructor(private readonly packs?: { available: () => boolean; unlock: () => Promise<boolean> }) {
    const dialog = this.#dialog
    dialog.className = 'emojiPicker'; dialog.setAttribute('aria-label', 'Choose an emoji')
    const title = document.createElement('h2'); title.textContent = 'Emoji'
    this.#query.type = 'search'; this.#query.placeholder = 'Search emoji'; this.#query.setAttribute('aria-label', 'Search emoji')
    this.#grid.className = 'emojiGrid'
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close emoji picker'
    close.addEventListener('click', () => dialog.close())
    const unlock = document.createElement('button'); unlock.type = 'button'; unlock.textContent = 'Unlock Nostr packs'
    const status = document.createElement('p'); status.setAttribute('role', 'status')
    unlock.addEventListener('click', async () => {
      unlock.disabled = true; status.textContent = 'Confirm this account in your signer…'
      try { status.textContent = await this.packs?.unlock() ? 'Nostr pack unlocked.' : 'No member packs found for this account.'; this.#render() }
      catch (error) { status.textContent = error instanceof Error ? error.message : 'The pack could not be unlocked.' }
      finally { unlock.disabled = false }
    })
    dialog.append(title, this.#query, this.#grid, unlock, status, close); document.body.append(dialog)
    this.#query.addEventListener('input', () => this.#render())
    dialog.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); dialog.close() } })
    dialog.addEventListener('close', () => { this.#choose = undefined; this.#query.value = ''; this.#return?.focus({ preventScroll: true }) })
  }
  open(from: HTMLElement, choose: (emoji: string) => void): void {
    this.#return = from; this.#choose = choose; this.#query.value = ''; this.#render(); this.#dialog.showModal(); this.#query.focus()
  }
  close(): void { this.#dialog.close() }
  #render(): void {
    this.#grid.replaceChildren()
    const query = this.#query.value.trim().toLocaleLowerCase()
    for (const [emoji, name] of [...(this.packs?.available() ? CULT_EMOJIS : []), ...EMOJI_CATALOG]) {
      const words = emoji === '🤦' ? 'facepalm head against wall frustrated ' + name : name
      if (!`${emoji} ${words}`.includes(query)) continue
      const button = document.createElement('button'); button.type = 'button'; button.append(emojiGlyph(emoji))
      button.setAttribute('aria-label', `${emoji} ${words}`); button.title = words
      button.addEventListener('click', () => { this.#choose?.(emoji); this.#dialog.close() })
      this.#grid.append(button)
      if (this.#grid.childElementCount >= 120) break
    }
    if (!query) { const hint = document.createElement('p'); hint.textContent = 'Search 3,781 emoji, including skin tones and flags.'; this.#grid.prepend(hint) }
    if (!this.#grid.childElementCount) this.#grid.textContent = 'No matching emoji. You can also use your keyboard’s emoji picker.'
  }
}
