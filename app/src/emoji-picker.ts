import { CULT_EMOJIS } from '../../src/custom-emoji.js'
import { emojiGlyph } from './custom-emoji.js'
import { EMOJI_CATALOG } from '../../src/emoji-catalog.js'
import { ORIGINAL_EMOJIS } from '../../src/original-art.js'
import { FAMILIAR_ART, familiarArtwork, familiarLabel, withSkinTone } from '../../src/familiar-emoji.js'

const toneKey = 'kithmoot:emoji:skinTone'
export function preferredSkinTone(): number {
  try { const value = Number(localStorage.getItem(toneKey)); return Number.isInteger(value) && value >= 0 && value <= 5 ? value : 0 } catch { return 0 }
}
export function preferredReaction(emoji: string): string { return withSkinTone(emoji, preferredSkinTone()) }
export function setPreferredSkinTone(tone: number): void {
  if (!Number.isInteger(tone) || tone < 0 || tone > 5) throw new RangeError('Unknown skin tone')
  try { localStorage.setItem(toneKey, String(tone)) } catch { /* The current picker also works without storage. */ }
}

/** Inserts into the selection saved when opening, preserving the conversation's draft. */
export class EmojiPicker {
  readonly #dialog = document.createElement('dialog')
  readonly #query = document.createElement('input')
  readonly #grid = document.createElement('div')
  readonly #tone = document.createElement('select')
  readonly #hint = document.createElement('p')
  readonly #tabs = new Map<string, HTMLButtonElement>()
  #choose?: (emoji: string) => void
  #return?: HTMLElement
  #section = 'familiar'
  constructor(private readonly packs?: { available: () => boolean; unlock: () => Promise<boolean> }) {
    const dialog = this.#dialog
    dialog.className = 'emojiPicker'; dialog.setAttribute('aria-label', 'Choose an emoji')
    const title = document.createElement('h2'); title.textContent = 'Emoji'
    this.#query.type = 'search'; this.#query.placeholder = 'Search emoji'; this.#query.setAttribute('aria-label', 'Search emoji')
    this.#grid.className = 'emojiGrid'
    const tabs = document.createElement('div'); tabs.className = 'emojiTabs'; tabs.setAttribute('aria-label', 'Emoji collections')
    for (const [key, label] of [['familiar', 'Familiar emoji'], ['forgesworn', 'ForgeSworn'], ['characters', 'Character stickers'], ['more', 'More emoji']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label
      button.onclick = () => { this.#section = key; this.#query.value = ''; this.#render() }
      this.#tabs.set(key!, button); tabs.append(button)
    }
    const toneLabel = document.createElement('label'); toneLabel.textContent = 'Hand colour '
    this.#tone.setAttribute('aria-label', 'Hand colour')
    for (const [index, label] of ['Yellow', 'Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark'].entries()) {
      const option = document.createElement('option'); option.value = String(index); option.textContent = label; this.#tone.append(option)
    }
    this.#tone.onchange = () => { try { localStorage.setItem(toneKey, this.#tone.value) } catch { /* Preference also works without storage. */ } this.#render() }
    toneLabel.append(this.#tone)
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close emoji picker'; close.onclick = () => dialog.close()
    const unlock = document.createElement('button'); unlock.type = 'button'; unlock.textContent = 'Unlock Nostr packs'
    const status = document.createElement('p'); status.setAttribute('role', 'status')
    unlock.addEventListener('click', async () => {
      unlock.disabled = true; status.textContent = 'Confirm this account in your signer…'
      try { status.textContent = await this.packs?.unlock() ? 'Nostr pack unlocked.' : 'No member packs found for this account.'; this.#render() }
      catch (error) { status.textContent = error instanceof Error ? error.message : 'The pack could not be unlocked.' }
      finally { unlock.disabled = false }
    })
    dialog.append(title, this.#query, tabs, toneLabel, this.#hint, this.#grid, unlock, status, close); document.body.append(dialog)
    this.#query.addEventListener('input', () => this.#render())
    dialog.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); dialog.close() } })
    dialog.addEventListener('close', () => { this.#choose = undefined; this.#query.value = ''; this.#return?.focus({ preventScroll: true }) })
  }
  open(from: HTMLElement, choose: (emoji: string) => void): void {
    this.#return = from; this.#choose = choose; this.#section = 'familiar'; this.#tone.value = String(preferredSkinTone()); this.#query.value = ''; this.#render(); this.#dialog.showModal(); this.#query.focus()
  }
  close(): void { this.#dialog.close() }
  #render(): void {
    this.#grid.replaceChildren()
    const query = this.#query.value.trim().toLocaleLowerCase()
    for (const [key, button] of this.#tabs) button.setAttribute('aria-pressed', String(key === this.#section))
    this.#tone.parentElement!.hidden = ['characters', 'forgesworn'].includes(this.#section) && !query
    this.#hint.textContent = this.#section === 'forgesworn' ? 'Our ForgeSworn and project icons.' : this.#section === 'characters' ? 'Our character stickers.' : this.#section === 'more' ? 'More Unicode emoji. Search to find a specific reaction.' : 'ForgeMoji by TheCryptoDonkey. Familiar meanings, our own artwork.'
    const allFamiliar: [string, string][] = FAMILIAR_ART.map(item => [withSkinTone(item.emoji, Number(this.#tone.value)), item.keywords])
    const familiar = allFamiliar.filter(([emoji]) => !FAMILIAR_ART.some(item => item.emoji === emoji && String(item.category) === 'forgesworn'))
    const brands = allFamiliar.filter(([emoji]) => FAMILIAR_ART.some(item => item.emoji === emoji && String(item.category) === 'forgesworn'))
    const characters: readonly (readonly [string, string])[] = [...ORIGINAL_EMOJIS, ...(this.packs?.available() ? CULT_EMOJIS : [])]
    const standard = EMOJI_CATALOG.filter(([emoji, name]) => !name.includes('flag') && !familiarArtwork(emoji))
    const entries = query ? [...allFamiliar, ...characters, ...standard] : this.#section === 'forgesworn' ? brands : this.#section === 'characters' ? characters : this.#section === 'more' ? standard : familiar
    const seen = new Set<string>()
    for (const [emoji, name] of entries) {
      const words = emoji === '🤦' ? 'facepalm head against wall frustrated ' + name : name
      if (seen.has(emoji) || !`${emoji} ${words}`.toLocaleLowerCase().includes(query)) continue
      seen.add(emoji)
      const label = familiarLabel(emoji) ?? words
      const button = document.createElement('button'); button.type = 'button'; button.append(emojiGlyph(emoji)); button.setAttribute('aria-label', `${emoji} ${label}`); button.title = label
      button.onclick = () => { this.#choose?.(emoji); this.#dialog.close() }; this.#grid.append(button)
      if (this.#grid.childElementCount >= 160) break
    }
    if (!this.#grid.childElementCount) this.#grid.textContent = 'No matching emoji. You can also use your keyboard’s emoji picker.'
  }
}
