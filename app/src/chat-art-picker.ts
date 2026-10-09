import './chat-art-picker.css'
import { EMOJI_CATALOG } from '../../src/emoji-catalog.js'
import { CULT_EMOJIS } from '../../src/custom-emoji.js'
import { ORIGINAL_EMOJIS } from '../../src/original-art.js'
import { FAMILIAR_ART, familiarArtwork, familiarLabel, withSkinTone } from '../../src/familiar-emoji.js'
import { emojiGlyph } from './custom-emoji.js'
import { preferredSkinTone, setPreferredSkinTone } from './emoji-picker.js'
import { searchMediaCatalogue, type CatalogueImage } from './media-catalogue.js'

type Mode = 'emoji' | 'stickers' | 'gifs'
type Collection = 'familiar' | 'recents' | 'forgesworn' | 'characters' | 'more'
type Choice = { emoji: string; name: string; words: string; category: string }
type Packs = { available: () => boolean; unlock: () => Promise<boolean> }
const recentKey = 'kithmoot:emoji:recents'
const normalise = (emoji: string) => emoji.replaceAll('\uFE0F', '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
const noFlag = (emoji: string, name: string) => !/flag/i.test(name) && !/[\u{1F1E6}-\u{1F1FF}\u{1F3F3}\u{1F3F4}]/u.test(emoji)
const definitions = new Map(FAMILIAR_ART.map(item => [normalise(item.emoji), item]))
const characterNames = new Map<string, string>(ORIGINAL_EMOJIS)
const cultNames = new Map<string, string>(CULT_EMOJIS)
const unicodeNames = new Map<string, string>(EMOJI_CATALOG.filter(([emoji, name]) => noFlag(emoji, name)))
function unicodeCategory(emoji: string, name: string): string {
  if (/face|smiling|grinning|laughing|crying|cat with|heart|kiss/i.test(name)) return 'Faces and hearts'
  if (/hand|finger|thumb|fist|palm|person|woman|man\b|people|family|boy|girl|baby|ear|nose|eye|foot|leg|arm|hair/i.test(name)) return 'People and hands'
  if (/food|fruit|vegetable|bread|cake|cookie|drink|glass|cup|bottle|dish|rice|meat|cheese|egg|coffee|tea\b|pizza|burger|chocolate|candy/i.test(name)) return 'Food and drink'
  const point = emoji.codePointAt(0) ?? 0
  if ((point >= 0x1F400 && point <= 0x1F43F) || /animal|bird|flower|tree|plant|sun|moon|cloud|rain|snow|star|leaf|fish|bug|spider|butterfly/i.test(name)) return 'Animals and nature'
  if (/car|bus|train|ship|plane|boat|building|house|place|mountain|beach|city|road|hotel|bridge/i.test(name)) return 'Travel and places'
  if (/ball|sport|game|medal|trophy|musical|music|guitar|drum|violin|tennis|golf/i.test(name)) return 'Activities'
  if (/sign|symbol|arrow|button|circle|square|triangle|number|digit|letter|keycap/i.test(name)) return 'Symbols'
  return 'Objects'
}

/** An original local picker shared by the composer and reactions. No catalogue service. */
export class ChatArtPicker {
  readonly #panel = document.createElement('div')
  readonly #title = document.createElement('h2')
  readonly #closeButton = document.createElement('button')
  readonly #searchToggle = document.createElement('button')
  readonly #collectionToggle = document.createElement('button')
  readonly #primary = document.createElement('div')
  readonly #collections = document.createElement('div')
  readonly #query = document.createElement('input')
  readonly #category = document.createElement('select')
  readonly #tone = document.createElement('select')
  readonly #toneLabel = document.createElement('label')
  readonly #scroll = document.createElement('div')
  readonly #grid = document.createElement('div')
  readonly #more = document.createElement('button')
  readonly #status = document.createElement('p')
  readonly #unlock = document.createElement('button')
  readonly #preview = document.createElement('div')
  readonly #tabs = new Map<Mode, HTMLButtonElement>()
  readonly #collectionButtons = new Map<Collection, HTMLButtonElement>()
  #mode: Mode = 'emoji'
  #collection: Collection = 'familiar'
  #reaction = false
  #anchor?: HTMLElement
  #returnFocus?: HTMLElement
  #onEmoji?: (emoji: string) => void
  #onMedia?: (item: CatalogueImage, signal: AbortSignal) => Promise<void>
  #onClose?: () => void
  #renderRequest?: AbortController
  #selectionRequest?: AbortController
  #choices: Choice[] = []
  #shown = 0
  #busy = false
  #longPress?: ReturnType<typeof setTimeout>
  #searchExpanded = false
  #compactCollectionsExpanded = false
  #previewTrigger?: HTMLElement

  constructor(private readonly packs?: Packs) {
    this.#panel.className = 'chatArtPicker'; this.#panel.hidden = true
    this.#panel.setAttribute('role', 'dialog'); this.#panel.setAttribute('aria-modal', 'false')
    const header = document.createElement('div'); header.className = 'chatArtPickerHeader'
    this.#title.textContent = 'Emoji'; this.#title.className = 'chatArtPickerTitle'
    this.#closeButton.type = 'button'; this.#closeButton.textContent = 'Close'; this.#closeButton.onclick = () => this.close()
    this.#primary.className = 'chatArtPickerTabs'; this.#primary.setAttribute('role', 'tablist'); this.#primary.setAttribute('aria-label', 'Message artwork')
    for (const [mode, label] of [['emoji', 'Emoji'], ['stickers', 'Stickers'], ['gifs', 'GIFs']] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.setAttribute('role', 'tab')
      button.onclick = () => this.#changeMode(mode); this.#tabs.set(mode, button); this.#primary.append(button)
    }
    this.#primary.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const modes = [...this.#tabs.keys()].filter(mode => !this.#tabs.get(mode)!.hidden)
      const index = modes.indexOf(this.#mode); const next = event.key === 'Home' ? modes[0]! : event.key === 'End' ? modes[modes.length - 1]! : modes[(index + (event.key === 'ArrowRight' ? 1 : modes.length - 1)) % modes.length]!
      event.preventDefault(); this.#changeMode(next); this.#tabs.get(next)!.focus()
    })
    this.#searchToggle.type = 'button'; this.#searchToggle.textContent = '🔍'; this.#searchToggle.setAttribute('aria-label', 'Search artwork'); this.#searchToggle.title = 'Search artwork'
    this.#searchToggle.onclick = () => {
      this.#searchExpanded = !this.#searchExpanded; this.#position()
      if (this.#searchExpanded) this.#query.focus({ preventScroll: true })
      else { this.#query.value = ''; this.#render() }
    }
    this.#collectionToggle.type = 'button'; this.#collectionToggle.textContent = '☰'; this.#collectionToggle.setAttribute('aria-label', 'Emoji collections'); this.#collectionToggle.title = 'Choose an emoji collection'
    this.#collectionToggle.onclick = () => {
      this.#compactCollectionsExpanded = !this.#compactCollectionsExpanded; this.#position()
      if (this.#compactCollectionsExpanded) this.#collectionButtons.get(this.#collection)?.focus({ preventScroll: true })
    }
    header.append(this.#title, this.#primary, this.#collectionToggle, this.#searchToggle, this.#closeButton)
    this.#query.type = 'search'; this.#query.className = 'chatArtPickerSearch'; this.#query.maxLength = 80
    this.#query.addEventListener('input', () => { if (this.#query.value) this.#category.value = ''; this.#render(); this.#position() })
    this.#collections.className = 'chatArtPickerCollections'; this.#collections.setAttribute('aria-label', 'Emoji collections')
    for (const [collection, label] of [['familiar', 'Familiar'], ['recents', 'Recents'], ['forgesworn', 'ForgeSworn'], ['characters', 'Characters'], ['more', 'More emoji']] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label
      button.onclick = () => { this.#collection = collection; this.#compactCollectionsExpanded = false; this.#query.value = ''; this.#populateCategories(); this.#render(); this.#position() }
      this.#collectionButtons.set(collection, button); this.#collections.append(button)
    }
    const filters = document.createElement('div'); filters.className = 'chatArtPickerFilters'
    this.#category.setAttribute('aria-label', 'Emoji category'); this.#category.onchange = () => this.#render()
    this.#toneLabel.textContent = 'Hand colour '; this.#tone.setAttribute('aria-label', 'Hand colour')
    for (const [index, name] of ['Yellow', 'Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark'].entries()) {
      const option = document.createElement('option'); option.value = String(index); option.textContent = name; this.#tone.append(option)
    }
    this.#tone.onchange = () => { setPreferredSkinTone(Number(this.#tone.value)); this.#render() }
    this.#toneLabel.append(this.#tone); filters.append(this.#category, this.#toneLabel)
    this.#scroll.className = 'chatArtPickerScroll'; this.#scroll.tabIndex = 0; this.#scroll.setAttribute('aria-label', 'Artwork choices')
    this.#more.type = 'button'; this.#more.className = 'chatArtPickerMore'; this.#more.onclick = () => this.#appendEmoji()
    this.#scroll.append(this.#grid, this.#more)
    this.#scroll.addEventListener('scroll', () => {
      if (!this.#more.hidden && this.#scroll.scrollHeight - this.#scroll.scrollTop - this.#scroll.clientHeight < 180) this.#appendEmoji()
    }, { passive: true })
    this.#status.className = 'chatArtPickerStatus'; this.#status.setAttribute('role', 'status')
    this.#unlock.type = 'button'; this.#unlock.textContent = 'Unlock Nostr packs'; this.#unlock.className = 'chatArtPickerUnlock'
    this.#unlock.onclick = async () => {
      this.#unlock.disabled = true; this.#status.textContent = 'Confirm this account in your signer…'
      try { const unlocked = await this.packs?.unlock(); this.#render(); this.#status.textContent = unlocked ? 'Nostr pack unlocked.' : 'No member packs found for this account.' }
      catch (error) { this.#status.textContent = error instanceof Error ? error.message : 'The pack could not be unlocked.' }
      finally { this.#unlock.disabled = false }
    }
    this.#preview.className = 'chatArtPickerPreview'; this.#preview.hidden = true
    this.#panel.append(header, this.#query, this.#collections, filters, this.#scroll, this.#status, this.#unlock, this.#preview)
    document.body.append(this.#panel)
    this.#panel.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); if (!this.#preview.hidden) this.#hidePreview(true); else this.close() }
    })
    document.addEventListener('keydown', event => {
      if (this.#panel.hidden || event.key !== 'Escape' || event.isComposing) return
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return
      event.preventDefault(); event.stopPropagation(); if (!this.#preview.hidden) this.#hidePreview(true); else this.close()
    }, { capture: true })
    document.addEventListener('pointerdown', event => {
      if (this.#panel.hidden || !(event.target instanceof Node) || this.#panel.contains(event.target)) return
      // Storage consent and signer dialogs retain their own explicit approval flow.
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return
      const form = this.#returnFocus?.closest('form') ?? this.#anchor?.closest('form')
      if (this.#anchor?.contains(event.target) || (!this.#reaction && (this.#returnFocus?.contains(event.target) || form?.contains(event.target)))) return
      this.close()
    })
    window.addEventListener('resize', () => this.#position())
    window.addEventListener('scroll', () => this.#position(), { passive: true, capture: true })
    window.visualViewport?.addEventListener('resize', () => this.#position())
    window.visualViewport?.addEventListener('scroll', () => this.#position())
  }

  openComposer(anchor: HTMLElement, returnFocus: HTMLElement, mode: Mode, onEmoji: (emoji: string) => void, onMedia: (item: CatalogueImage, signal: AbortSignal) => Promise<void>, onClose?: () => void): void {
    this.close()
    this.#reaction = false; this.#anchor = anchor; this.#returnFocus = returnFocus; this.#onEmoji = onEmoji; this.#onMedia = onMedia; this.#onClose = onClose
    this.#open(mode)
  }
  openReaction(anchor: HTMLElement, choose: (emoji: string) => void): void {
    this.close()
    this.#reaction = true; this.#anchor = anchor; this.#returnFocus = anchor; this.#onEmoji = choose; this.#onMedia = undefined; this.#onClose = undefined
    this.#open('emoji')
  }
  close(): void {
    if (this.#panel.hidden) return
    if (this.#longPress) clearTimeout(this.#longPress)
    this.#panel.hidden = true; this.#renderRequest?.abort(); this.#selectionRequest?.abort(); this.#hidePreview()
    const onClose = this.#onClose
    this.#onEmoji = undefined; this.#onMedia = undefined; this.#onClose = undefined; this.#busy = false
    if (this.#returnFocus?.isConnected) this.#returnFocus.focus({ preventScroll: true })
    onClose?.()
  }
  #open(mode: Mode): void {
    this.#selectionRequest?.abort(); this.#busy = false; this.#searchExpanded = false; this.#compactCollectionsExpanded = false; this.#collection = 'familiar'; this.#tone.value = String(preferredSkinTone()); this.#query.value = ''
    const touch = matchMedia('(hover: none), (pointer: coarse)').matches
    if (touch && (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)) document.activeElement.blur()
    this.#panel.hidden = false; this.#changeMode(mode); this.#position()
    // Touch users can browse first, with no keyboard covering the choices.
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) this.#query.focus({ preventScroll: true })
    else this.#tabs.get(this.#mode)?.focus({ preventScroll: true })
  }
  #changeMode(mode: Mode): void {
    this.#mode = this.#reaction ? 'emoji' : mode; this.#query.value = ''; this.#hidePreview()
    const emoji = this.#mode === 'emoji'
    this.#title.textContent = this.#reaction ? 'React with an emoji' : emoji ? 'Emoji' : this.#mode === 'stickers' ? 'Stickers' : 'GIFs'
    this.#panel.setAttribute('aria-label', emoji ? 'Choose an emoji' : 'GIFs and stickers')
    this.#closeButton.setAttribute('aria-label', emoji ? 'Close emoji picker' : 'Close media picker')
    this.#query.setAttribute('aria-label', emoji ? 'Search emoji' : 'Search GIFs and stickers')
    this.#query.placeholder = emoji ? 'Search faces, hands, animals…' : this.#mode === 'stickers' ? 'Try facepalm, love, celebration…' : 'Search the coffee animation'
    for (const [key, button] of this.#tabs) { button.hidden = this.#reaction && key !== 'emoji'; button.setAttribute('aria-selected', String(key === this.#mode)); button.tabIndex = key === this.#mode ? 0 : -1 }
    this.#collections.hidden = !emoji; this.#populateCategories(); this.#render(); this.#position()
  }
  #populateCategories(): void {
    this.#category.replaceChildren(); const all = document.createElement('option'); all.value = ''; all.textContent = 'All categories'; this.#category.append(all)
    if (this.#collection === 'familiar') for (const name of [...new Set(FAMILIAR_ART.filter(item => String(item.category) !== 'forgesworn').map(item => item.category))]) {
      const option = document.createElement('option'); option.value = name; option.textContent = name; this.#category.append(option)
    }
    if (this.#collection === 'more') for (const name of ['Faces and hearts', 'People and hands', 'Animals and nature', 'Food and drink', 'Travel and places', 'Activities', 'Objects', 'Symbols']) {
      const option = document.createElement('option'); option.value = name; option.textContent = name; this.#category.append(option)
    }
  }
  #knownChoice(emoji: string): Choice | undefined {
    const definition = definitions.get(normalise(emoji))
    if (definition && familiarArtwork(emoji)) return { emoji, name: definition.title, words: definition.keywords, category: definition.category }
    const character = characterNames.get(emoji); if (character) return { emoji, name: character, words: character, category: 'Characters' }
    const cult = this.packs?.available() ? cultNames.get(emoji) : undefined; if (cult) return { emoji, name: cult, words: cult, category: 'Characters' }
    const name = unicodeNames.get(emoji); if (name) return { emoji, name, words: name, category: unicodeCategory(emoji, name) }
    return undefined
  }
  #recents(): Choice[] {
    try { const stored: unknown = JSON.parse(localStorage.getItem(recentKey) ?? '[]'); return Array.isArray(stored) ? stored.slice(0, 36).flatMap(value => typeof value === 'string' ? this.#knownChoice(value) ?? [] : []) : [] } catch { return [] }
  }
  #remember(emoji: string): void {
    if (!this.#knownChoice(emoji)) return
    try { localStorage.setItem(recentKey, JSON.stringify([emoji, ...this.#recents().map(item => item.emoji).filter(value => value !== emoji)].slice(0, 36))) } catch { /* Recents are optional. */ }
  }
  #emojiChoices(): Choice[] {
    const tone = Number(this.#tone.value)
    const own = FAMILIAR_ART.map(item => ({ emoji: withSkinTone(item.emoji, tone), name: item.title, words: item.keywords, category: String(item.category) }))
    const familiar = own.filter(item => item.category !== 'forgesworn'), brands = own.filter(item => item.category === 'forgesworn')
    const characters = [...ORIGINAL_EMOJIS, ...(this.packs?.available() ? CULT_EMOJIS : [])].map(([emoji, words]) => ({ emoji, name: words, words, category: 'Characters' }))
    const more = [...unicodeNames].filter(([emoji]) => !familiarArtwork(emoji)).map(([emoji, name]) => ({ emoji, name, words: emoji === '🤦' ? `facepalm head against wall frustrated ${name}` : name, category: unicodeCategory(emoji, name) }))
    const query = this.#query.value.trim().toLocaleLowerCase()
    const entries = query ? [...own, ...characters, ...more] : this.#collection === 'recents' ? this.#recents() : this.#collection === 'forgesworn' ? brands : this.#collection === 'characters' ? characters : this.#collection === 'more' ? more : familiar
    const seen = new Set<string>()
    return entries.filter(item => {
      if (seen.has(item.emoji) || (this.#category.value && item.category !== this.#category.value) || !`${item.emoji} ${item.name} ${item.words}`.toLocaleLowerCase().includes(query)) return false
      seen.add(item.emoji); return true
    })
  }
  #render(): void {
    this.#renderRequest?.abort(); this.#grid.replaceChildren(); this.#scroll.scrollTop = 0; this.#more.hidden = true; this.#hidePreview()
    const emoji = this.#mode === 'emoji'; this.#grid.className = emoji ? 'emojiGrid' : 'mediaGrid'
    this.#category.hidden = !emoji || !['familiar', 'more'].includes(this.#collection)
    this.#toneLabel.hidden = !emoji || ['forgesworn', 'characters'].includes(this.#collection)
    this.#unlock.hidden = !emoji || this.#collection !== 'characters' || !this.packs || Boolean(this.packs.available())
    for (const [key, button] of this.#collectionButtons) button.setAttribute('aria-pressed', String(key === this.#collection))
    if (emoji) {
      this.#choices = this.#emojiChoices(); this.#shown = 0; this.#appendEmoji()
      if (!this.#choices.length) this.#status.textContent = this.#collection === 'recents' && !this.#query.value ? 'Your recent emoji will appear here.' : 'No matching emoji. Try another word.'
      return
    }
    const request = this.#renderRequest = new AbortController(); this.#status.textContent = 'Our original artwork. Search stays on this device.'
    void searchMediaCatalogue(this.#query.value, this.#mode === 'stickers', request.signal).then(items => {
      if (this.#renderRequest !== request || request.signal.aborted || this.#panel.hidden) return
      this.#status.textContent = items.length ? this.#mode === 'gifs' ? 'One acted coffee animation. Preview it or add it to your draft.' : `${items.length} original stickers. Choose one to add to your draft.` : this.#mode === 'gifs' ? 'No matching GIF. The coffee animation is available here.' : 'No matching stickers. Try another word.'
      for (const item of items) this.#grid.append(this.#mediaCard(item))
    }).catch(error => { if (!request.signal.aborted) this.#status.textContent = error instanceof Error ? error.message : 'The artwork could not be opened.' })
  }
  #appendEmoji(): void {
    const end = Math.min(this.#shown + 240, this.#choices.length)
    for (const item of this.#choices.slice(this.#shown, end)) {
      const button = document.createElement('button'); button.type = 'button'; button.title = item.name; button.setAttribute('aria-label', `${item.emoji} ${familiarLabel(item.emoji) ?? item.name}`)
      button.append(emojiGlyph(item.emoji)); button.onclick = () => {
        this.#remember(item.emoji); this.#onEmoji?.(item.emoji)
        if (this.#reaction) this.close()
        else { this.#status.textContent = `${item.name} added to your draft.`; if (matchMedia('(hover: none), (pointer: coarse)').matches) button.focus({ preventScroll: true }) }
      }
      this.#grid.append(button)
    }
    this.#shown = end; this.#more.hidden = end >= this.#choices.length; this.#more.textContent = `Show more emoji (${end} of ${this.#choices.length})`
    this.#status.textContent = `${this.#choices.length} emoji${this.#more.hidden ? '' : ' · scroll to browse more'}.`
  }
  #mediaCard(item: CatalogueImage): HTMLElement {
    const card = document.createElement('div'); card.className = 'chatArtPickerMediaCard'
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-label', `Add ${item.name}`); button.title = `Add ${item.name} to your draft`
    const image = document.createElement('img'); image.src = matchMedia('(prefers-reduced-motion: reduce)').matches ? item.preview : item.url; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'
    const name = document.createElement('span'); name.textContent = item.name.replace(/\.(gif|png)$/i, '')
    button.setAttribute('aria-label', `Preview ${item.name}`); button.title = `Preview ${item.name}`
    button.append(image, name); button.onclick = () => this.#showPreview(item, button)
    let press: { x: number; y: number } | undefined
    button.addEventListener('pointerdown', event => {
      if (this.#longPress) clearTimeout(this.#longPress)
      if (event.pointerType !== 'mouse') { press = { x: event.clientX, y: event.clientY }; this.#longPress = setTimeout(() => this.#showPreview(item, button), 450) }
    })
    button.addEventListener('pointermove', event => { if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8 && this.#longPress) clearTimeout(this.#longPress) })
    for (const event of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(event, () => { if (this.#longPress) clearTimeout(this.#longPress) })
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'chatArtPickerPreviewButton'; preview.textContent = 'Add to message'; preview.setAttribute('aria-label', `Add ${item.name}`); preview.onclick = () => { void this.#chooseMedia(item) }
    card.append(button, preview); return card
  }
  #showPreview(item: CatalogueImage, trigger?: HTMLElement): void {
    this.#preview.replaceChildren(); this.#preview.hidden = false
    this.#previewTrigger = trigger
    this.#scroll.inert = true; this.#scroll.setAttribute('aria-hidden', 'true')
    const back = document.createElement('button'); back.type = 'button'; back.textContent = 'Back to choices'; back.onclick = () => this.#hidePreview(true)
    const image = document.createElement('img'); image.src = matchMedia('(prefers-reduced-motion: reduce)').matches ? item.preview : item.url; image.alt = item.name.replace(/\.(gif|png)$/i, ''); image.referrerPolicy = 'no-referrer'
    const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add to message'; add.setAttribute('aria-label', `Add ${item.name}`); add.onclick = () => { this.#hidePreview(); void this.#chooseMedia(item) }
    this.#preview.append(back, image, add); back.focus({ preventScroll: true })
  }
  #hidePreview(restoreFocus = false): void {
    this.#preview.hidden = true; this.#preview.replaceChildren(); this.#scroll.inert = false; this.#scroll.removeAttribute('aria-hidden')
    if (restoreFocus && this.#previewTrigger?.isConnected) this.#previewTrigger.focus({ preventScroll: true })
    this.#previewTrigger = undefined
  }
  async #chooseMedia(item: CatalogueImage): Promise<void> {
    if (this.#busy || !this.#onMedia) return
    const request = this.#selectionRequest = new AbortController(); this.#busy = true; this.#status.textContent = 'Adding artwork to your draft…'
    try { await this.#onMedia(item, request.signal); if (!request.signal.aborted) this.close() }
    catch (error) { if (!request.signal.aborted) this.#status.textContent = error instanceof Error ? error.message : 'Could not add this file.' }
    finally { if (this.#selectionRequest === request) this.#busy = false }
  }
  #position(): void {
    if (this.#panel.hidden || !this.#anchor) return
    const viewport = window.visualViewport
    const leftEdge = viewport?.offsetLeft ?? 0, topEdge = viewport?.offsetTop ?? 0, width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight
    const phone = width < 640; this.#panel.classList.toggle('chatArtPickerPhone', phone)
    this.#query.hidden = phone && !this.#searchExpanded; this.#searchToggle.hidden = !phone; this.#searchToggle.setAttribute('aria-expanded', String(this.#searchExpanded)); this.#closeButton.textContent = phone ? '×' : 'Close'
    const anchor = this.#anchor.getBoundingClientRect(), composer = this.#returnFocus?.closest('form')?.getBoundingClientRect()
    const panelWidth = Math.min(phone ? width - 12 : 460, width - 16)
    const bottom = Math.min(topEdge + height - 8, (composer && !this.#reaction ? composer.top : anchor.top) - 8)
    const availableAbove = Math.max(0, bottom - topEdge - 8)
    const belowTop = Math.max(topEdge + 8, anchor.bottom + 8)
    const availableBelow = Math.max(0, topEdge + height - 8 - belowTop)
    const wanted = Math.min(phone ? 450 : 540, Math.max(180, height - (phone ? 112 : 24)))
    const above = this.#reaction ? availableAbove >= availableBelow : availableAbove >= Math.min(wanted, 240) || availableAbove >= availableBelow
    const available = above ? availableAbove : availableBelow
    const panelHeight = Math.min(wanted, available >= 180 ? available : height - 16)
    const top = available < 180 ? topEdge + 8 : above ? Math.max(topEdge + 8, bottom - panelHeight) : belowTop
    const compact = height < 500 || panelHeight < 340
    this.#panel.classList.toggle('chatArtPickerCompact', compact)
    this.#collectionToggle.hidden = !compact || this.#mode !== 'emoji'; this.#collectionToggle.setAttribute('aria-expanded', String(this.#compactCollectionsExpanded))
    this.#collections.classList.toggle('chatArtPickerCollectionsOpen', this.#compactCollectionsExpanded)
    const left = phone ? leftEdge + 6 : Math.max(leftEdge + 8, Math.min(anchor.right - panelWidth, leftEdge + width - panelWidth - 8))
    this.#panel.style.width = `${panelWidth}px`; this.#panel.style.height = `${Math.min(panelHeight, height - 16)}px`; this.#panel.style.left = `${left}px`; this.#panel.style.top = `${top}px`
  }
}
