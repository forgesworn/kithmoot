import './people.css'
import { npubEncode } from 'nostr-tools/nip19'
import { icon, type IconName } from './icons.js'
import { avatarInitial, avatarSlot } from './room-sections.js'

/**
 * People: the signed-in person's contacts, and the people they follow on
 * Nostr, with Message, Voice, Video and Invite on each.
 *
 * Only drawing lives here. Where a person comes from (a Signet grant, a
 * contact card, the account's follow list), whether they may be messaged,
 * and what Message or Voice actually do all come in from `main.ts`, so this
 * file holds no keys and opens no sockets. It fills two containers the app
 * shell owns: `#peopleList` in the list column and `#peoplePane` in the main
 * pane.
 */
export interface Person {
  pubkey: string
  /** The best name known: a Signet grant, then a contact card, then a profile. */
  name?: string
  picture?: string
  /** Signet's Kin, Kith or Ken, when the grant shares tiers. */
  tier?: string
  /** A Signet check, or a word check done here. */
  checked?: boolean
  /** Contact cards and Signet grants are contacts; follows are Following. */
  section: 'contacts' | 'following'
  /** Where a contact came from, said when there is no tier or check to show. */
  source?: 'signet' | 'card'
  /** A Nostr address, only once it has been checked. */
  address?: string
}

export interface PeopleModel {
  contacts: Person[]
  following: Person[]
  /** Why Following may be empty: lookups off, still asking, or answered. */
  followStatus: 'off' | 'none' | 'loading' | 'ready'
  /** A line about the Signet contacts, when they need attention. */
  contactsNote?: string
}

export interface PeopleActions {
  /** Undefined when Message, Voice and Video can be used; otherwise why not. */
  blockedReason(pubkey: string): string | undefined
  message(person: Person): Promise<string | undefined>
  call(person: Person, video: boolean): Promise<string | undefined>
  /** Open the private chat, then choose a room to invite them to. */
  invite(person: Person): Promise<string | undefined>
  /** The private chat already open with this person, if there is one. */
  privateChat(pubkey: string): { label: string; open(): void } | undefined
  /** Look up names and pictures for these keys (the public-profile switch decides). */
  want(pubkeys: string[]): void
  pasteCard(opener: HTMLElement): void
  linkSignet(opener: HTMLElement): void
  showMyCard(opener: HTMLElement): void
  /** At phone width, show the contact over the list; elsewhere a no-op. */
  openDetail(): void
  closeDetail(): void
}

/** Names are asked for in batches of this many, so a long follow list is
 *  several small requests rather than one huge one. */
const WANT_BATCH = 100

export class PeopleView {
  readonly #list: HTMLElement
  readonly #pane: HTMLElement
  readonly #model: () => PeopleModel
  readonly #actions: PeopleActions
  readonly #query: HTMLInputElement
  readonly #rows: HTMLUListElement
  readonly #status: HTMLElement
  readonly #empty: HTMLElement
  readonly #menu: HTMLElement
  readonly #add: HTMLButtonElement
  #selected: string | undefined
  #busy = false
  #note = ''
  #wanted = new Set<string>()
  /** What the pane last drew, so a redraw that changes nothing leaves its
   *  buttons in place: a profile arriving mid-click must not swap them. */
  #painted = ''
  /** The order last drawn, kept while the pointer or focus is in the list,
   *  so a name arriving does not move the row about to be pressed. */
  #order: string[] | undefined

  constructor(list: HTMLElement, pane: HTMLElement, model: () => PeopleModel, actions: PeopleActions) {
    this.#list = list
    this.#pane = pane
    this.#model = model
    this.#actions = actions
    list.classList.add('peopleList')
    pane.classList.add('peoplePane')

    const head = document.createElement('div')
    head.className = 'listHead'
    const title = document.createElement('h2')
    title.id = 'peopleTitle'
    title.textContent = 'People'
    this.#add = document.createElement('button')
    this.#add.type = 'button'
    this.#add.id = 'peopleAdd'
    this.#add.className = 'iconButton'
    this.#add.setAttribute('aria-label', 'Add a contact')
    this.#add.title = 'Add a contact'
    this.#add.setAttribute('aria-haspopup', 'menu')
    this.#add.setAttribute('aria-expanded', 'false')
    this.#add.append(icon('personAdd'))
    head.append(title, this.#add)

    this.#menu = this.#buildMenu()

    const label = document.createElement('label')
    label.className = 'sr-only'
    label.htmlFor = 'peopleQuery'
    label.textContent = 'Find a person'
    const search = document.createElement('div')
    search.className = 'listSearch'
    this.#query = document.createElement('input')
    this.#query.id = 'peopleQuery'
    this.#query.type = 'search'
    this.#query.autocomplete = 'off'
    this.#query.placeholder = 'Find a person'
    this.#query.addEventListener('input', () => { this.#order = undefined; this.render() })
    search.append(icon('search'), this.#query)

    this.#status = document.createElement('p')
    this.#status.id = 'peopleStatus'
    this.#status.className = 'note'
    this.#status.setAttribute('role', 'status')

    this.#rows = document.createElement('ul')
    this.#rows.id = 'peopleRows'
    this.#rows.setAttribute('aria-labelledby', 'peopleTitle')
    this.#rows.addEventListener('keydown', event => this.#move(event))
    for (const leave of ['pointerleave', 'focusout'] as const) this.#rows.addEventListener(leave, () => {
      queueMicrotask(() => { if (!this.#held()) { this.#order = undefined; this.render() } })
    })

    this.#empty = document.createElement('div')
    this.#empty.id = 'peopleEmpty'
    this.#empty.className = 'peopleEmpty'
    const none = document.createElement('p')
    none.textContent = 'No contacts yet.'
    const addCard = this.#textButton('Add a contact', opener => this.#openMenu(opener))
    const link = this.#textButton('Link Signet contacts', opener => this.#actions.linkSignet(opener))
    this.#empty.append(none, addCard, link)

    list.replaceChildren(head, this.#menu, label, search, this.#status, this.#rows, this.#empty)
    this.#add.addEventListener('click', () => this.#openMenu(this.#add))
    this.#paintPane()
  }

  /** The person on show, if any. */
  get selected(): string | undefined { return this.#selected }

  /** Redraw from the model. Cheap enough to call on every change. */
  render(): void {
    const model = this.#model()
    const query = this.#query.value.trim().toLocaleLowerCase()
    const matches = (person: Person): boolean => !query
      || `${person.name ?? ''} ${npubEncode(person.pubkey)}`.toLocaleLowerCase().includes(query)
    const byName = (a: Person, b: Person): number => {
      if (!a.name !== !b.name) return a.name ? -1 : 1
      return (a.name ?? a.pubkey).localeCompare(b.name ?? b.pubkey, undefined, { sensitivity: 'base' })
    }
    const sections: [string, Person[]][] = [
      ['Contacts', model.contacts.filter(matches).sort(byName)],
      ['Following', model.following.filter(matches).sort(byName)],
    ]
    // Names for everyone listed, a batch at a time. The follow list is
    // public already, so asking about its people tells the relays nothing
    // new; the switch in Settings still decides whether anything is asked.
    // Lookups switched off forget every profile, so ask again once back on.
    if (model.followStatus === 'off') this.#wanted.clear()
    const fresh = [...model.contacts, ...model.following].map(person => person.pubkey).filter(key => !this.#wanted.has(key))
    for (const key of fresh) this.#wanted.add(key)
    for (let i = 0; i < fresh.length; i += WANT_BATCH) this.#actions.want(fresh.slice(i, i + WANT_BATCH))

    let people = sections.flatMap(([, list]) => list)
    if (this.#held() && this.#order) {
      const at = new Map(this.#order.map((key, index) => [key, index]))
      const kept = (person: Person) => at.get(person.pubkey) ?? Number.MAX_SAFE_INTEGER
      for (const section of sections) section[1].sort((a, b) => kept(a) - kept(b))
      people = sections.flatMap(([, list]) => list)
    } else {
      this.#order = people.map(person => person.pubkey)
    }

    const previous = new Map([...this.#rows.querySelectorAll<HTMLLIElement>('li[data-person]')].map(row => [row.dataset.person!, row]))
    const heads = new Map([...this.#rows.querySelectorAll<HTMLLIElement>('li[data-section]')].map(row => [row.dataset.section!, row]))
    const children: HTMLLIElement[] = []
    for (const [name, list] of sections) {
      const followingNote = name === 'Following' ? this.#followingNote(model, query) : undefined
      if (!list.length && !followingNote) continue
      const head = heads.get(name) ?? document.createElement('li')
      head.dataset.section = name
      head.className = 'peopleSection'
      const heading = head.querySelector('h3') ?? document.createElement('h3')
      heading.textContent = name
      const note = head.querySelector('p') ?? document.createElement('p')
      note.className = 'note'
      note.textContent = followingNote ?? ''
      note.hidden = !followingNote
      if (!head.childElementCount) head.append(heading, note)
      children.push(head)
      for (const person of list) children.push(this.#row(person, previous.get(person.pubkey)))
    }
    const focused = document.activeElement
    for (const row of [...this.#rows.children]) if (!children.includes(row as HTMLLIElement)) row.remove()
    children.forEach((row, index) => { if (this.#rows.children[index] !== row) this.#rows.insertBefore(row, this.#rows.children[index] ?? null) })
    if (focused instanceof HTMLElement && !focused.isConnected) this.#query.focus({ preventScroll: true })

    // One tab stop for the whole list: the chosen row, else the first.
    const buttons = [...this.#rows.querySelectorAll<HTMLButtonElement>('button[data-action="person"]')]
    const stop = buttons.find(button => button.closest<HTMLElement>('li')?.dataset.person === this.#selected) ?? buttons[0]
    for (const button of buttons) button.tabIndex = button === stop ? 0 : -1

    const anyone = model.contacts.length + model.following.length > 0
    this.#empty.hidden = anyone || model.followStatus === 'loading'
    this.#status.textContent = this.#note || model.contactsNote
      || (query && anyone && !people.length ? `Nobody matches “${this.#query.value.trim()}”.` : '')
    this.#status.hidden = !this.#status.textContent
    if (this.#selected && !people.some(person => person.pubkey === this.#selected)
      && ![...model.contacts, ...model.following].some(person => person.pubkey === this.#selected)) this.#selected = undefined
    this.#paintPane()
  }

  /** Show this person (or nobody). */
  select(pubkey: string | undefined): void {
    this.#selected = pubkey
    this.#note = ''
    this.render()
  }

  #followingNote(model: PeopleModel, query: string): string | undefined {
    if (query) return undefined
    if (model.followStatus === 'off') return 'Turn on public profiles in Settings to see the people you follow.'
    if (model.followStatus === 'loading' && !model.following.length) return 'Looking for the people you follow…'
    return undefined
  }

  #held(): boolean {
    return this.#rows.contains(document.activeElement) || this.#rows.matches(':hover')
  }

  #row(person: Person, existing: HTMLLIElement | undefined): HTMLLIElement {
    const row = existing ?? document.createElement('li')
    row.dataset.person = person.pubkey
    row.className = 'personRow'
    const button = row.querySelector<HTMLButtonElement>('button') ?? document.createElement('button')
    button.type = 'button'
    button.dataset.action = 'person'
    const chosen = person.pubkey === this.#selected
    if (chosen) button.setAttribute('aria-current', 'true')
    else button.removeAttribute('aria-current')
    const name = person.name ?? shortNpub(person.pubkey)
    const sub = subline(person)
    button.setAttribute('aria-label', [name, sub].filter(Boolean).join(', '))
    button.onclick = () => {
      this.select(person.pubkey)
      this.#actions.openDetail()
    }
    const text = document.createElement('span')
    text.className = 'personText'
    const title = document.createElement('span')
    title.className = 'personName'
    title.textContent = name
    if (person.checked) title.append(checkMark())
    text.append(title)
    if (sub) {
      const second = document.createElement('span')
      second.className = 'personSub'
      second.textContent = sub
      text.append(second)
    }
    const drawn = JSON.stringify([name, sub, person.picture, person.checked])
    if (button.dataset.drawn !== drawn) {
      button.dataset.drawn = drawn
      button.replaceChildren(avatar(person, 'personAvatar'), text)
    }
    if (!row.contains(button)) row.append(button)
    return row
  }

  /** Up and Down walk the list, Home and End jump: one tab stop for all of it. */
  #move(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...this.#rows.querySelectorAll<HTMLButtonElement>('button[data-action="person"]')]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.min(buttons.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
    for (const button of buttons) button.tabIndex = -1
    buttons[next]!.tabIndex = 0
    buttons[next]!.focus()
  }

  #paintPane(): void {
    const model = this.#model()
    const person = [...model.contacts, ...model.following].find(entry => entry.pubkey === this.#selected)
    const shown = person ? JSON.stringify([person, this.#actions.blockedReason(person.pubkey), this.#busy, this.#note, this.#actions.privateChat(person.pubkey)?.label]) : 'none'
    if (shown === this.#painted && this.#pane.childElementCount) return
    this.#painted = shown
    if (!person) {
      const blank = document.createElement('div')
      blank.className = 'peopleBlank'
      const line = document.createElement('p')
      line.textContent = 'Pick someone to message or call.'
      blank.append(line)
      this.#pane.replaceChildren(blank)
      return
    }
    const name = person.name ?? shortNpub(person.pubkey)
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'iconButton peopleBack'
    back.setAttribute('aria-label', 'Back to people')
    back.title = 'Back to people'
    back.append(icon('back'))
    back.addEventListener('click', () => {
      this.#actions.closeDetail()
      this.#rows.querySelector<HTMLButtonElement>(`li[data-person="${person.pubkey}"] button`)?.focus()
    })

    const card = document.createElement('div')
    card.className = 'contactCard'
    const heading = document.createElement('h2')
    heading.id = 'peoplePaneTitle'
    heading.tabIndex = -1
    heading.textContent = name
    const meta = document.createElement('p')
    meta.className = 'contactMeta'
    const sub = subline(person)
    if (person.checked) meta.append(checkMark())
    if (sub) meta.append(document.createTextNode(sub))
    const npub = npubEncode(person.pubkey)
    const key = document.createElement('span')
    key.className = 'contactKey'
    key.textContent = shortNpub(person.pubkey)
    key.title = npub
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'iconButton'
    copy.setAttribute('aria-label', `Copy ${name}'s public key`)
    copy.title = 'Copy public key'
    copy.append(icon('copy'))
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(npub).then(() => { this.#say('Public key copied.') }, () => { this.#say('Copying is not allowed here.') })
    })
    meta.append(key, copy)

    const reason = this.#actions.blockedReason(person.pubkey)
    const actions = document.createElement('div')
    actions.className = 'contactActions'
    actions.setAttribute('role', 'group')
    actions.setAttribute('aria-label', `Actions for ${name}`)
    const action = (id: string, label: string, glyph: IconName, run: (opener: HTMLButtonElement) => void | Promise<unknown>, needsChat = true) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.id = id
      button.className = 'contactAction'
      button.append(icon(glyph))
      const text = document.createElement('span')
      text.textContent = label
      button.append(text)
      button.disabled = this.#busy || (needsChat && !!reason)
      button.addEventListener('click', () => {
        const result = run(button)
        if (!(result instanceof Promise)) return
        this.#busy = true
        this.#paintPane()
        void result.then(note => { this.#note = typeof note === 'string' ? note : '' }, error => { this.#note = error instanceof Error ? error.message : String(error) })
          .finally(() => { this.#busy = false; this.render() })
      })
      return button
    }
    actions.append(
      action('peopleMessage', 'Message', 'chat', () => this.#actions.message(person)),
      action('peopleVoice', 'Voice', 'phone', () => this.#actions.call(person, false)),
      action('peopleVideo', 'Video', 'video', () => this.#actions.call(person, true)),
      action('peopleInvite', 'Invite', 'personAdd', () => this.#actions.invite(person)),
    )
    const note = document.createElement('p')
    note.id = 'peopleActionNote'
    note.className = 'note'
    note.setAttribute('role', 'status')
    note.textContent = this.#note || reason || (person.section === 'following'
      ? 'Message, Voice and Video start a private chat. They reach this person only if they use KithMoot.' : '')

    card.append(avatar(person, 'contactAvatar'), heading, meta, actions, note)
    const chat = this.#actions.privateChat(person.pubkey)
    if (chat) {
      const section = document.createElement('section')
      section.className = 'contactSection'
      const title = document.createElement('h3')
      title.textContent = 'Private chat'
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'contactLink'
      open.textContent = chat.label
      open.append(icon('chevron'))
      open.addEventListener('click', () => chat.open())
      section.append(title, open)
      card.append(section)
    }
    const focusHeading = this.#pane.contains(document.activeElement) && document.activeElement !== heading
    this.#pane.replaceChildren(back, card)
    if (focusHeading) heading.focus({ preventScroll: true })
  }

  #say(text: string): void {
    this.#note = text
    this.#paintPane()
  }

  #textButton(label: string, run: (opener: HTMLButtonElement) => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'quiet'
    button.textContent = label
    button.addEventListener('click', () => run(button))
    return button
  }

  /** Add a contact: a native popover menu, so Escape and a click outside
   *  close it, with the arrow keys moving between its three items. */
  #buildMenu(): HTMLElement {
    const menu = document.createElement('div')
    menu.id = 'peopleAddMenu'
    menu.className = 'popoverMenu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Add a contact')
    menu.popover = 'auto'
    const item = (label: string, run: (opener: HTMLElement) => void) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.tabIndex = -1
      button.textContent = label
      button.addEventListener('click', () => { menu.hidePopover(); run(this.#add) })
      return button
    }
    menu.append(
      item('Paste a contact card or its link…', opener => this.#actions.pasteCard(opener)),
      item('Link Signet contacts…', opener => this.#actions.linkSignet(opener)),
      item('Show my card', opener => this.#actions.showMyCard(opener)),
    )
    menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus()
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        items[event.key === 'Home' ? 0 : items.length - 1]!.focus()
      } else if (event.key === 'Tab') {
        menu.hidePopover()
      }
    })
    menu.addEventListener('toggle', event => {
      const open = (event as ToggleEvent).newState === 'open'
      this.#add.setAttribute('aria-expanded', String(open))
      if (open) menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
      else if (menu.contains(document.activeElement) || document.activeElement === document.body) this.#add.focus({ preventScroll: true })
    })
    return menu
  }

  #openMenu(opener: HTMLElement): void {
    const box = opener.getBoundingClientRect()
    this.#menu.style.top = `${Math.round(box.bottom + 4)}px`
    this.#menu.style.left = `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - 280)))}px`
    this.#menu.showPopover()
  }
}

export function shortNpub(pubkey: string): string {
  const npub = npubEncode(pubkey)
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`
}

/** The line under a name, the same on web and Android: "Kith · checked"
 *  when Signet shares them, else where the contact came from; for someone
 *  followed, their Nostr address once checked, else nothing. */
function subline(person: Person): string {
  if (person.section === 'following') return person.address ?? ''
  const trust = [person.tier ? person.tier[0]!.toUpperCase() + person.tier.slice(1) : '', person.checked ? 'checked' : ''].filter(Boolean).join(' · ')
  return trust || (person.source === 'signet' ? 'Signet' : person.source === 'card' ? 'Contact card' : '')
}

function avatar(person: Person, className: string): HTMLElement {
  return personAvatar(person.pubkey, person.name, person.picture, className)
}

/** A round avatar: the initial in a colour taken from the key, with the
 *  picture over it when there is one. Invitations use it too, so a person
 *  looks the same in Chats and in People. */
export function personAvatar(pubkey: string, name: string | undefined, picture: string | undefined, className: string): HTMLElement {
  const span = document.createElement('span')
  span.className = className
  span.dataset.slot = String(avatarSlot(pubkey))
  span.setAttribute('aria-hidden', 'true')
  span.textContent = avatarInitial(name ?? npubEncode(pubkey).slice(5))
  if (picture) {
    const image = document.createElement('img')
    image.alt = ''
    image.loading = 'lazy'
    image.referrerPolicy = 'no-referrer'
    image.src = picture
    image.addEventListener('error', () => image.remove(), { once: true })
    span.append(image)
  }
  return span
}

function checkMark(): SVGSVGElement {
  const mark = icon('check')
  mark.classList.add('checkedMark')
  mark.removeAttribute('aria-hidden')
  mark.setAttribute('role', 'img')
  mark.setAttribute('aria-label', 'checked')
  return mark
}
