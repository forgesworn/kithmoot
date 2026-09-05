const EMOJIS = [
  ['👍', 'thumbs up yes like'], ['❤️', 'heart love'], ['🤦', 'facepalm smacking head against wall frustrated'],
  ['😂', 'laugh tears joy'], ['😊', 'smile happy'], ['🎉', 'party celebration'], ['👀', 'eyes looking'],
  ['🙏', 'thanks please pray'], ['😢', 'sad crying'], ['🤯', 'mind blown exploding head'], ['🙄', 'eye roll'],
  ['😅', 'nervous relieved sweat smile'], ['🔥', 'fire'], ['👏', 'clap applause'], ['💯', 'hundred perfect'],
  ['✅', 'done check yes'], ['❌', 'no cross'], ['🤔', 'thinking'], ['👋', 'wave hello goodbye'],
  ['🤗', 'hug'], ['😍', 'heart eyes'], ['😡', 'angry'], ['💔', 'broken heart'], ['🍻', 'cheers beer'],
  ['☕', 'coffee tea'], ['🚀', 'rocket'], ['💪', 'strong muscle'], ['🤞', 'fingers crossed luck'],
] as const

/** Inserts into the selection saved when opening, preserving the current conversation's draft. */
export class EmojiPicker {
  readonly #dialog = document.createElement('dialog')
  readonly #query = document.createElement('input')
  readonly #grid = document.createElement('div')
  #choose?: (emoji: string) => void
  #return?: HTMLElement
  constructor() {
    const dialog = this.#dialog
    dialog.className = 'emojiPicker'; dialog.setAttribute('aria-label', 'Choose an emoji')
    const title = document.createElement('h2'); title.textContent = 'Emoji'
    this.#query.type = 'search'; this.#query.placeholder = 'Search emoji'; this.#query.setAttribute('aria-label', 'Search emoji')
    this.#grid.className = 'emojiGrid'
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close emoji picker'
    close.addEventListener('click', () => dialog.close())
    dialog.append(title, this.#query, this.#grid, close); document.body.append(dialog)
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
    for (const [emoji, words] of EMOJIS) {
      if (!`${emoji} ${words}`.includes(query)) continue
      const button = document.createElement('button'); button.type = 'button'; button.textContent = emoji
      button.setAttribute('aria-label', `${emoji} ${words}`); button.title = words
      button.addEventListener('click', () => { this.#choose?.(emoji); this.#dialog.close() })
      this.#grid.append(button)
    }
    if (!this.#grid.childElementCount) this.#grid.textContent = 'No matching emoji. You can also use your keyboard’s emoji picker.'
  }
}
