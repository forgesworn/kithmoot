import './people-thread.css'
import { icon } from './icons.js'
import { dayWords, personAvatar, shortNpub } from './people.js'
import type { NostrMessage } from './nostr-message.js'
import type { NostrPeopleThread, ReadOutcome } from './people-nostr-inbox.js'

/**
 * One Nostr message thread, drawn inside the People pane: the transcript, the
 * intro card at its top, and the composer. The words in a thread come from
 * the account's inbox (`PeopleNostrInbox`); a message being sent is driven by
 * a `NostrMessage` engine, one per message, made by the host. This file holds
 * no keys and opens no sockets. The engine keeps every guard it had in the
 * old dialog: this only calls `review`, `send` and `snapshot` and says what
 * they say.
 */

/** Why the composer is, or is not, usable right now. */
export type Availability = { ready: true } | { ready: false; text: string; action?: { label: string; run(): void } }

export interface ThreadHost {
  self(): string | undefined
  thread(peer: string): NostrPeopleThread | undefined
  availability(): Availability
  /** A new engine for one message, or none when this account cannot send. */
  engine(changed: () => void): NostrMessage | undefined
  /** Saves these messages as read; settles once the write has finished or failed. */
  markRead(ids: string[]): Promise<ReadOutcome | undefined> | void
  /** Whether the pane is on screen (one pane under 900 px hides it). */
  visible(): boolean
  /** Whether to focus the field on selecting a row (not on touch). */
  focusField(): boolean
}

export interface ThreadSubject {
  pubkey: string
  name: string
  picture?: string
  address?: string
  request: boolean
  hasChat: boolean
  /** Opens the saved private chat. */
  openChat(): void
  invite(opener: HTMLElement): void
  info(opener: HTMLElement): void
  /** Blocks them on this device. */
  block(): void
}

interface Pending {
  key: number
  text: string
  engine: NostrMessage
  /** The last words the engine gave, kept for when it closes under us. */
  last: ReturnType<NostrMessage['snapshot']>
  startedAt: number
  announced: boolean
  details: boolean
}

const MAX_BYTES = 4096
const encoder = new TextEncoder()

export function timeWords(at: number): string {
  return new Date(at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export const SENT_WORDS = 'Sent to their inbox relay'

export class PeopleThreadView {
  readonly element = document.createElement('div')
  readonly #host: ThreadHost
  readonly #drafts = new Map<string, string>()
  readonly #pending = new Map<string, Pending[]>()
  readonly #seen = new Map<string, Set<string>>()
  #key = 0
  #subject?: ThreadSubject
  #scroll = document.createElement('div')
  #log = document.createElement('ol')
  #intro = document.createElement('div')
  #outcomeNote = document.createElement('p')
  #bar = document.createElement('div')
  #announce = document.createElement('p')
  #form = document.createElement('form')
  #barState = ''
  #introKey = ''
  #barRun: (() => void) | undefined
  #input = document.createElement('textarea')
  #send = document.createElement('button')
  #count = document.createElement('span')
  #lane = document.createElement('span')
  #timer?: number
  #focusFor?: string
  /** The read write in hand, if any, and which messages it was last for. */
  #reading = { busy: false, key: '' }

  constructor(host: ThreadHost) {
    this.#host = host
    this.element.id = 'peopleThread'
    this.element.className = 'peopleThread'
    this.#scroll.className = 'peopleThreadScroll'
    this.#intro.className = 'peopleIntro'
    const logBox = document.createElement('div')
    logBox.className = 'peopleThreadLogBox'
    logBox.setAttribute('role', 'log')
    this.#log.className = 'peopleThreadLog'
    logBox.append(this.#log)
    this.#scroll.append(this.#intro, logBox)
    this.#announce.id = 'peopleThreadAnnounce'
    this.#announce.className = 'sr-only'
    this.#announce.setAttribute('role', 'status')
    this.#announce.setAttribute('aria-live', 'polite')
    this.#outcomeNote.className = 'peopleThreadStatus note'
    this.#outcomeNote.setAttribute('role', 'status')
    this.#bar.className = 'peopleThreadBar'
    this.#form.className = 'peopleComposer'
    this.#form.noValidate = true
    const field = document.createElement('div')
    field.className = 'peopleComposerField'
    this.#lane.className = 'peopleLane'
    this.#lane.setAttribute('aria-hidden', 'true')
    this.#lane.textContent = 'Nostr'
    this.#input.id = 'peopleThreadInput'
    this.#input.rows = 1
    this.#input.maxLength = 16384
    this.#input.autocomplete = 'off'
    this.#input.setAttribute('enterkeyhint', 'send')
    this.#send.type = 'button'
    this.#send.id = 'peopleThreadSend'
    this.#send.className = 'peopleSend'
    this.#send.setAttribute('aria-label', 'Send')
    this.#send.append(icon('send'))
    this.#count.className = 'peopleCount note'
    this.#count.setAttribute('aria-live', 'polite')
    field.append(this.#lane, this.#input, this.#send)
    this.#form.append(field, this.#count)
    this.element.append(this.#scroll, this.#announce, this.#outcomeNote, this.#bar, this.#form)

    this.#form.addEventListener('submit', event => event.preventDefault())
    this.#input.addEventListener('input', () => {
      if (this.#subject) this.#drafts.set(this.#subject.pubkey, this.#input.value)
      this.#grow(); this.#paintComposer()
    })
    this.#input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        if (event.isTrusted) void this.#submit()
      } else if (event.key === 'Escape' && !this.#input.value && window.matchMedia('(max-width: 899px)').matches) {
        this.element.dispatchEvent(new CustomEvent('thread:back', { bubbles: true }))
      }
    })
    this.#send.addEventListener('click', event => { if (event.isTrusted) void this.#submit() })
  }

  get subject(): ThreadSubject | undefined { return this.#subject }

  /** Draw this person's thread. A person already on show is only redrawn. */
  show(subject: ThreadSubject): void {
    const changed = this.#subject?.pubkey !== subject.pubkey
    if (changed && this.#subject) this.#drafts.set(this.#subject.pubkey, this.#input.value)
    this.#subject = subject
    if (changed) {
      this.#input.value = this.#drafts.get(subject.pubkey) ?? ''
      this.#log.replaceChildren()
      this.#scroll.dataset.fresh = '1'
      this.#focusFor = subject.pubkey
      // Opening a thread again tries again, after a write the device refused.
      this.#reading.key = ''
    }
    // At Huge text the name would wrap inside a one-line field, so the label carries it instead.
    this.#input.placeholder = document.documentElement.dataset.textSize === 'huge' ? 'Message' : `Message ${subject.name}`
    this.#input.setAttribute('aria-label', `Message ${subject.name} on Nostr`)
    this.#log.parentElement!.setAttribute('aria-label', `Messages with ${subject.name}`)
    this.reconcile()
  }

  /** Redraw from the inbox and the engines, leaving the field and its focus alone. */
  reconcile(): void {
    const subject = this.#subject
    if (!subject) return
    const self = this.#host.self()
    const thread = this.#host.thread(subject.pubkey)
    const messages = thread?.messages ?? []
    const pending = this.#pending.get(subject.pubkey) ?? []
    for (const entry of pending) this.#refresh(entry)
    const merged = new Map(pending.filter(entry => entry.last.messageId).map(entry => [entry.last.messageId!, entry]))
    const near = this.#scroll.scrollHeight - this.#scroll.scrollTop - this.#scroll.clientHeight < 80 || this.#scroll.dataset.fresh === '1'

    const seen = this.#seen.get(subject.pubkey)
    const incoming = messages.filter(message => message.author !== self)
    if (seen) for (const message of incoming) if (!seen.has(message.id)) this.#say(`${subject.name}: ${message.text.slice(0, 100)}`)
    this.#seen.set(subject.pubkey, new Set(incoming.map(message => message.id)))

    this.#paintIntro(subject)
    const items: HTMLElement[] = []
    let day = ''
    const now = Date.now()
    const newestMine = [...messages].reverse().find(message => message.author === self)?.id
    const add = (at: number, bubble: HTMLElement) => {
      const label = dayWords(at, now)
      if (label !== day) {
        day = label
        const divider = document.createElement('li')
        divider.className = 'peopleDay'
        divider.textContent = label
        items.push(divider)
      }
      items.push(bubble as HTMLLIElement)
    }
    for (const message of messages) {
      const mine = message.author === self
      const live = merged.get(message.id)
      add(message.sentAt, this.#bubble(subject, message.text, message.sentAt, mine, mine ? {
        entry: live, saved: message.sendStatus, newest: message.id === newestMine,
      } : undefined))
    }
    for (const entry of pending) if (!entry.last.messageId || !messages.some(message => message.id === entry.last.messageId)) {
      add(Math.floor(entry.startedAt / 1000), this.#bubble(subject, entry.text, Math.floor(entry.startedAt / 1000), true, { entry, newest: true }))
    }
    this.#log.replaceChildren(...items)
    if (near) {
      this.#scroll.scrollTop = this.#scroll.scrollHeight
      // A pane that has no height yet is scrolled again once it has one.
      if (this.#scroll.clientHeight > 0) delete this.#scroll.dataset.fresh
      else requestAnimationFrame(() => { if (this.#scroll.dataset.fresh === '1' && this.#scroll.clientHeight > 0) { this.#scroll.scrollTop = this.#scroll.scrollHeight; delete this.#scroll.dataset.fresh } })
    }

    const busy = pending.find(entry => entry.last.busy)
    const status = busy && ['checking', 'preparing'].includes(busy.last.phase) ? busy.last.status : ''
    this.#outcomeNote.textContent = status
    this.#outcomeNote.hidden = !status
    this.#paintBar()
    this.#paintComposer()
    if (this.#host.visible() && thread?.unread) this.#markRead(subject.pubkey, messages.filter(message => message.author !== self).map(message => message.id))
    if (this.#focusFor === subject.pubkey && this.#host.visible() && this.#host.focusField() && this.#input.offsetParent) {
      this.#focusFor = undefined
      this.#input.focus({ preventScroll: true })
    }
  }

  /** The field, for a caller that wants to focus it. */
  get field(): HTMLTextAreaElement { return this.#input }

  /** Engines close when People closes or the identity changes. */
  close(): void {
    window.clearTimeout(this.#timer)
    for (const list of this.#pending.values()) for (const entry of list) entry.engine.close()
    this.#pending.clear()
  }

  /** One read write at a time, and one for each set of messages on screen. Two redraws in
   *  one turn would otherwise race for the same lock, and a write the device keeps refusing
   *  would be retried on every redraw; the inbox line already reports a refusal. */
  #markRead(peer: string, ids: string[]): void {
    const key = `${peer}:${ids.join(',')}`
    if (this.#reading.busy || this.#reading.key === key) return
    this.#reading = { busy: true, key }
    const reading = this.#reading
    void Promise.resolve(this.#host.markRead(ids)).catch((): ReadOutcome => 'refused').then(outcome => {
      reading.busy = false
      // Nothing was written (the inbox was changing), so the next redraw asks again.
      if (outcome !== 'saved' && outcome !== 'refused') { reading.key = ''; return }
      // What arrived while the write was in hand is read now; the same set is not asked again.
      const current = this.#subject
      if (outcome === 'saved' && current && this.#host.visible() && this.#host.thread(current.pubkey)?.unread) this.reconcile()
    })
  }

  #refresh(entry: Pending): void {
    const now = entry.engine.snapshot()
    // A closed engine reports nothing; what it last said is what is shown.
    if (now.phase !== 'closed') {
      if (now.phase === 'not-sent' && entry.last.phase !== 'not-sent' && !entry.announced) {
        entry.announced = true
        this.#say(`Not sent. ${now.status}`)
      }
      entry.last = now
    }
  }

  #bubble(subject: ThreadSubject, text: string, at: number, mine: boolean,
    outcome?: { entry?: Pending; saved?: string; newest: boolean }): HTMLLIElement {
    const item = document.createElement('li')
    item.className = `msg ${mine ? 'mine' : 'theirs'} peopleMsg`
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const body = document.createElement('p')
    body.className = 'peopleMsgText'
    body.textContent = text
    const meta = document.createElement('div')
    meta.className = 'messageMeta'
    const time = document.createElement('time')
    time.dateTime = new Date(at * 1000).toISOString()
    time.textContent = timeWords(at)
    meta.append(time)
    bubble.append(body, meta)
    item.append(bubble)
    if (outcome) this.#outcome(item, subject, text, outcome)
    return item
  }

  #outcome(item: HTMLLIElement, subject: ThreadSubject, text: string, outcome: { entry?: Pending; saved?: string; newest: boolean }): void {
    const line = document.createElement('div')
    line.className = 'deliveryLine peopleOutcome'
    const say = (words: string) => { const span = document.createElement('span'); span.textContent = words; line.append(span) }
    const button = (label: string, run: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'; b.className = 'quiet'; b.textContent = label
      b.addEventListener('click', event => { if (event.isTrusted) run() })
      line.append(b)
    }
    const entry = outcome.entry
    if (entry) {
      const snap = entry.last
      if (snap.busy) {
        if (/^Syncing your encrypted inbox copy/.test(snap.status)) say(`${SENT_WORDS} · Syncing your copy…`)
        else if (Date.now() - entry.startedAt >= 300) say('Sending…')
        else this.#later(300 - (Date.now() - entry.startedAt))
      } else if (snap.phase === 'sent') { say(SENT_WORDS); line.title = `${SENT_WORDS}. Delivery to their device is unconfirmed.`; this.#relays(line, entry) }
      else if (snap.phase === 'copy-unconfirmed') {
        say(`${SENT_WORDS} · Your copy didn't sync`)
        if (snap.retry) button('Retry sync', () => { void entry.engine.send().then(() => this.reconcile()) })
        this.#relays(line, entry)
      } else if (snap.phase === 'unconfirmed') {
        say('Not confirmed by their inbox relay')
        if (snap.retry) button('Retry', () => { void entry.engine.send().then(() => this.reconcile()) })
        this.#relays(line, entry)
      } else if (snap.phase === 'not-sent') {
        say(`Not sent. ${snap.status}`)
        button('Retry', () => { void this.#retry(subject, entry) })
        button('Edit', () => this.#edit(subject, entry))
        if (/inbox relays/.test(snap.status) && /needs usable|published in their/.test(snap.status)) button('Invite to KithMoot', () => subject.invite(item))
      } else if (snap.review === undefined && !snap.attempted) say('Sending…')
      else if (snap.busy === false && snap.phase === 'closed') say('Not sent')
    } else if (outcome.saved && outcome.newest) {
      const words = outcome.saved === 'sent' ? SENT_WORDS
        : outcome.saved === 'copy-unconfirmed' ? `${SENT_WORDS} · Your copy didn't sync` : 'Not confirmed by their inbox relay'
      say(words)
      line.title = outcome.saved === 'sent' ? `${SENT_WORDS}. Delivery to their device is unconfirmed.` : ''
    } else if (outcome.newest === false && !outcome.saved) {
      line.title = 'Send status not kept on this device'
    }
    if (line.childElementCount) item.append(line)
  }

  #relays(line: HTMLElement, entry: Pending): void {
    const review = entry.last.review
    if (!review) return
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'deliveryTick quiet'
    toggle.setAttribute('aria-label', 'Delivery details')
    toggle.setAttribute('aria-expanded', String(entry.details))
    toggle.append(icon('check'))
    toggle.addEventListener('click', event => { if (event.isTrusted) { entry.details = !entry.details; this.reconcile() } })
    line.append(toggle)
    if (!entry.details) return
    const detail = document.createElement('p')
    detail.className = 'peopleRelays note'
    const lines = [`Their inbox relays: ${review.recipientRelays.join(', ')}`, `Your inbox relays: ${review.senderRelays.join(', ')}`]
    if (entry.last.unconfirmedRelays?.length) lines.push(`Did not confirm: ${entry.last.unconfirmedRelays.join(', ')}`)
    detail.textContent = lines.join(' · ')
    line.append(detail)
  }

  async #retry(subject: ThreadSubject, entry: Pending): Promise<void> {
    if (!entry.last.review) await entry.engine.review(subject.pubkey, entry.text)
    await entry.engine.send()
    this.reconcile()
  }

  #edit(subject: ThreadSubject, entry: Pending): void {
    entry.engine.close()
    const list = this.#pending.get(subject.pubkey) ?? []
    this.#pending.set(subject.pubkey, list.filter(other => other !== entry))
    // Back to this thread's field, in memory only: a failed bubble is never kept.
    this.#drafts.set(subject.pubkey, entry.text)
    this.#input.value = entry.text
    this.#grow(); this.reconcile()
    this.#input.focus()
  }

  async #submit(): Promise<void> {
    const subject = this.#subject
    const text = this.#input.value
    if (!subject || !text.trim() || this.#busy() || !this.#host.availability().ready) return
    if (encoder.encode(text).byteLength > MAX_BYTES) return
    const engine = this.#host.engine(() => this.reconcile())
    if (!engine) return
    const entry: Pending = { key: ++this.#key, text, engine, last: engine.snapshot(), startedAt: Date.now(), announced: false, details: false }
    const list = this.#pending.get(subject.pubkey) ?? []
    list.push(entry)
    this.#pending.set(subject.pubkey, list)
    this.#input.value = ''; this.#drafts.set(subject.pubkey, '')
    this.#grow(); this.reconcile()
    await engine.review(subject.pubkey, text)
    this.#refresh(entry)
    if (engine.snapshot().phase === 'ready') await engine.send()
    this.#refresh(entry)
    this.reconcile()
    // Focus stays in the field through the whole send (it was never left).
    if (document.activeElement !== this.#input && this.element.contains(document.activeElement) === false && this.#host.focusField()) this.#input.focus({ preventScroll: true })
  }

  #busy(): boolean {
    return (this.#pending.get(this.#subject?.pubkey ?? '') ?? []).some(entry => entry.last.busy)
  }

  /** Send a note with no composer involved (the one-line note before an invitation). */
  async sendNote(subject: ThreadSubject, text: string): Promise<void> {
    const engine = this.#host.engine(() => this.reconcile())
    if (!engine) return
    const entry: Pending = { key: ++this.#key, text, engine, last: engine.snapshot(), startedAt: Date.now(), announced: false, details: false }
    const list = this.#pending.get(subject.pubkey) ?? []
    list.push(entry); this.#pending.set(subject.pubkey, list)
    await engine.review(subject.pubkey, text)
    this.#refresh(entry)
    if (engine.snapshot().phase === 'ready') await engine.send()
    this.#refresh(entry)
    this.reconcile()
  }

  #later(ms: number): void {
    window.clearTimeout(this.#timer)
    this.#timer = window.setTimeout(() => this.reconcile(), ms + 20)
  }

  #say(text: string): void {
    this.#announce.textContent = ''
    window.setTimeout(() => { this.#announce.textContent = text }, 30)
  }

  #grow(): void {
    this.#input.style.height = 'auto'
    this.#input.style.height = `${Math.min(this.#input.scrollHeight, 144)}px`
    this.#input.parentElement?.classList.toggle('grown', this.#input.scrollHeight > 48)
  }

  #paintBar(): void {
    const state = this.#host.availability()
    // Left alone while it says the same, so a press is never lost to a redraw.
    const key = state.ready ? '' : `${state.text}|${state.action?.label ?? ''}`
    if (key === this.#barState && this.#bar.hidden === state.ready) { this.#barRun = state.ready ? undefined : state.action?.run; return }
    this.#barState = key
    this.#bar.replaceChildren()
    this.#bar.hidden = state.ready
    this.#barRun = state.ready ? undefined : state.action?.run
    if (state.ready) return
    const text = document.createElement('span')
    text.textContent = state.text
    this.#bar.append(text)
    if (state.action) {
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'quiet'; button.textContent = state.action.label
      button.addEventListener('click', event => { if (event.isTrusted) this.#barRun?.() })
      this.#bar.append(button)
    }
  }

  #paintComposer(): void {
    const ready = this.#host.availability().ready
    this.#form.hidden = !ready
    const bytes = encoder.encode(this.#input.value).byteLength
    const left = MAX_BYTES - bytes
    this.#count.textContent = left < 0 ? `Too long by ${-left} bytes` : left <= 200 ? `${left} bytes left` : ''
    this.#send.disabled = !this.#input.value.trim() || left < 0 || this.#busy()
    this.#send.setAttribute('aria-disabled', String(this.#send.disabled))
  }

  #paintIntro(subject: ThreadSubject): void {
    // Drawn again only when what it says changes, so its buttons survive a redraw of the thread.
    const shown = JSON.stringify([subject.pubkey, subject.name, subject.address, subject.picture, subject.request, subject.hasChat])
    if (shown === this.#introKey && this.#intro.childElementCount) return
    this.#introKey = shown
    const card = document.createDocumentFragment()
    const head = document.createElement('div')
    head.className = 'peopleIntroHead'
    const words = document.createElement('div')
    const name = document.createElement('p')
    name.className = 'peopleIntroName'
    name.textContent = subject.name
    const key = document.createElement('p')
    key.className = 'peopleIntroKey note'
    key.textContent = subject.address ?? shortNpub(subject.pubkey)
    // A request is already named by its short key, so it is not said twice.
    words.append(name)
    if (!subject.request) words.append(key)
    head.append(personAvatar(subject.pubkey, subject.request ? undefined : subject.name, subject.picture, 'peopleIntroAvatar'), words)
    const lines = document.createElement('div')
    lines.className = 'peopleIntroLines'
    const add = (text: string, strong = false) => { const p = document.createElement('p'); p.className = strong ? 'peopleIntroStrong' : 'note'; p.textContent = text; lines.append(p) }
    if (subject.request) { add('Message request', true); add('You don’t follow this person. Their name and picture stay hidden unless you reply.') }
    add('Encrypted Nostr messages. Relays can see who a message is for and when it arrives, not what it says.')
    add('Older messages may not show on this device.')
    const buttons = document.createElement('div')
    buttons.className = 'peopleIntroButtons'
    const button = (label: string, run: (opener: HTMLElement) => void) => {
      const b = document.createElement('button')
      b.type = 'button'; b.className = 'quiet'; b.textContent = label
      b.addEventListener('click', event => { if (event.isTrusted) run(b) })
      buttons.append(b)
    }
    button(subject.hasChat ? 'Open private chat' : 'Invite to KithMoot', opener => subject.hasChat ? subject.openChat() : subject.invite(opener))
    button('Contact info', opener => subject.info(opener))
    const calls = document.createElement('p')
    calls.className = 'peopleIntroCalls note'
    calls.textContent = `Calls ring only if ${subject.name} uses KithMoot.`
    card.append(head, lines, buttons, calls)
    if (subject.request) {
      const bar = document.createElement('div')
      bar.className = 'peopleRequestBar'
      const text = document.createElement('span')
      text.textContent = `${shortNpub(subject.pubkey)} isn’t in your contacts or follows. Replying lets them know this account reads messages.`
      const block = document.createElement('button')
      block.type = 'button'; block.className = 'quiet danger'; block.textContent = 'Block'
      block.addEventListener('click', event => { if (event.isTrusted) subject.block() })
      bar.append(text, block)
      card.append(bar)
    }
    this.#intro.replaceChildren(card)
  }
}
