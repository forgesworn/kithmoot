import './people.css'
import { npubEncode } from 'nostr-tools/nip19'
import { icon, type IconName } from './icons.js'
import { avatarInitial, avatarSlot } from './room-sections.js'
import { setPeoplePicture } from './people-pictures.js'
import { peopleSearchKey, peopleSearchQuery, type PeopleSearchResult } from './people-search.js'
import { menuGroups, menuItem, wireMenu, type MenuHandle } from './menu.js'
import { PeopleThreadView, timeWords, type ThreadHost, type ThreadSubject } from './people-thread.js'

/**
 * People: the signed-in person's contacts, and the people they follow on
 * Nostr, and the Nostr conversations with them, as one list. Choosing a
 * person opens their thread in the main pane (people-thread.ts); Contact info
 * is a page, or at wide widths a side panel, over the same pane.
 *
 * Only drawing lives here. Where a person comes from (a Signet grant, a
 * contact card, the account's follow list), whether they may be messaged,
 * and what Invite or a call actually do all come in from `main.ts`, so this
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
  section: 'contacts' | 'following' | 'conversations' | 'nostr'
  /** Where a contact came from, said when there is no tier or check to show. */
  source?: 'signet' | 'card'
  /** A Nostr address, only once it has been checked. */
  address?: string
  chatName?: string
  /** Unread count of an existing Nostr conversation, including zero. */
  unread?: number
  /** The newest message of their Nostr thread, and where it sits in the inbox's order. */
  last?: { at: number; text: string; mine: boolean }
  rank?: number
  /** Somebody not in contacts or follows who has written first (P6). */
  request?: boolean
}

export interface SharedRoom {
  roomId: string
  label: string
  open(): void
}

export interface SentInvitation extends SharedRoom {
  /** When it was sent, unix seconds; unknown for one sent before this was kept. */
  at?: number
  joined: boolean
}

export interface PeopleModel {
  contacts: Person[]
  following: Person[]
  conversations: Person[]
  /** Why Following may be empty: lookups off, still asking, or answered. */
  followStatus: 'off' | 'none' | 'loading' | 'ready'
  /** A line about the Signet contacts, when they need attention. */
  contactsNote?: string
}

/** What the Invite menu offers for one person, and why not when it cannot. */
export interface InviteOptions {
  privateChat: { enabled: boolean; existing: boolean; reason?: string }
  room: { enabled: boolean; reason?: string }
}

export interface PeopleActions {
  profileSettings(): { enabled: boolean; available: boolean }
  setPublicProfiles(enabled: boolean): void
  /** Undefined when Voice and Video can be used; otherwise why not. */
  blockedReason(pubkey: string): string | undefined
  call(person: Person, video: boolean): Promise<string | undefined>
  inviteOptions(person: Person): InviteOptions
  /** Open the saved private chat, else start one. `note` runs just before a
   *  new invitation goes, and not when an existing chat is only opened. */
  invitePrivateChat(person: Person, note: () => Promise<void>): Promise<string | undefined>
  /** Open the private chat, then choose a room to invite them to. */
  invite(person: Person, note: () => Promise<void>): Promise<string | undefined>
  /** The private chat already open with this person, if there is one. */
  privateChat(pubkey: string): { label: string; open(): void } | undefined
  /** Whether this person's key was checked, and the line that says so. */
  check(person: Person): { status: 'verified' | 'unknown' | 'key-changed'; line: string }
  /** Open the private chat and start comparing words there. */
  checkWords(person: Person): Promise<string | undefined>
  /** Rooms this device has seen this person in, worked out here alone. */
  sharedRooms(pubkey: string): SharedRoom[]
  /** Rooms this device invited this person to, and whether they came. */
  sentInvitations(pubkey: string): SentInvitation[]
  /** Block on this device. Nothing is published and the person is not
   *  told. They leave People, as Signet's blocks do; Settings › Privacy
   *  lists them and undoes it. Throws with a sentence to show when it cannot. */
  block(pubkey: string): void
  /** Look up names and pictures for these keys (the public-profile switch decides). */
  want(pubkeys: string[]): void
  canSearchNostr(): boolean
  searchNostr(query: string, signal: AbortSignal): Promise<PeopleSearchResult[]>
  isBlocked(pubkey: string): boolean
  /** The state of the Nostr inbox, as one line over the list. */
  inboxLine(): { text: string; action?: { label: string; run(): void } } | undefined
  thread: ThreadHost
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
const SEARCH_MIN_GAP = 1_500

export class PeopleView {
  readonly #list: HTMLElement
  readonly #pane: HTMLElement
  readonly #model: () => PeopleModel
  readonly #actions: PeopleActions
  readonly #query: HTMLInputElement
  readonly #thread: PeopleThreadView
  #searchRequest?: AbortController
  #searchResults: PeopleSearchResult[] = []
  #searchNote = ''
  #lastSearch = -Infinity
  readonly #rows: HTMLUListElement
  readonly #status: HTMLElement
  readonly #line: HTMLElement
  readonly #empty: HTMLElement
  readonly #menu: HTMLElement
  readonly #add: HTMLButtonElement
  readonly #title: HTMLElement
  #selected: string | undefined
  #info = false
  #busy = false
  #note = ''
  #wanted = new Set<string>()
  #inviteMenu?: { handle: MenuHandle; menu: HTMLElement }
  #moreMenu?: { handle: MenuHandle; menu: HTMLElement }
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
    this.#thread = new PeopleThreadView(actions.thread)
    list.classList.add('peopleList')
    pane.classList.add('peoplePane')
    pane.addEventListener('thread:back', () => this.#back())

    const head = document.createElement('div')
    head.id = 'peopleListHead'
    head.className = 'listHead'
    this.#title = document.createElement('h2')
    this.#title.id = 'peopleTitle'
    this.#title.tabIndex = -1
    this.#title.textContent = 'People'
    this.#add = document.createElement('button')
    this.#add.type = 'button'
    this.#add.id = 'peopleAdd'
    this.#add.className = 'iconButton'
    this.#add.setAttribute('aria-label', 'Add a contact')
    this.#add.title = 'Add a contact'
    this.#add.setAttribute('aria-haspopup', 'menu')
    this.#add.setAttribute('aria-expanded', 'false')
    this.#add.append(icon('personAdd'))
    head.append(this.#title, this.#add)

    this.#menu = this.#buildMenu()

    const form = document.createElement('form')
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
    this.#query.placeholder = 'Name or npub'
    this.#query.addEventListener('input', () => { this.#order = undefined; this.#note = ''; this.resetSearch(); this.render() })
    // Enter opens the one person the box has narrowed the list to (a pasted key, a unique name).
    this.#query.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || !event.isTrusted || event.isComposing) return
      const only = this.#rows.querySelectorAll<HTMLButtonElement>('li[data-person] button[data-action="person"]')
      if (only.length === 1) { event.preventDefault(); only[0].click() }
    })
    search.append(icon('search'), this.#query)
    form.append(label, search)
    form.addEventListener('submit', event => event.preventDefault())

    this.#line = document.createElement('p')
    this.#line.id = 'peopleInboxLine'
    this.#line.className = 'note peopleInboxLine'
    this.#line.setAttribute('role', 'status')
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

    list.replaceChildren(head, this.#menu, form, this.#line, this.#status, this.#rows, this.#empty)
    this.#add.addEventListener('click', () => this.#openMenu(this.#add))
    this.#paintPane()
  }

  /** The person on show, if any. */
  get selected(): string | undefined { return this.#selected }

  /** Redraw only the thread, when the inbox or an engine has changed. */
  reconcileThread(): void { if (this.#selected) this.#paintPane() }

  /** Engines close when People closes or the identity changes. */
  closeThreads(): void { this.#thread.close() }

  resetSearch(): void {
    this.#searchRequest?.abort()
    this.#searchRequest = undefined
    this.#searchResults = []
    this.#searchNote = ''
  }

  async #searchNostr(): Promise<void> {
    const query = peopleSearchQuery(this.#query.value)
    if (!query || !this.#actions.canSearchNostr() || this.#searchRequest) return
    if (performance.now() - this.#lastSearch < SEARCH_MIN_GAP) {
      this.#searchNote = 'Wait a moment and try again.'
      this.render()
      return
    }
    this.#lastSearch = performance.now()
    const request = new AbortController()
    this.#searchRequest = request
    this.#searchNote = 'Searching Nostr…'
    this.render()
    try {
      const rows = await this.#actions.searchNostr(query, request.signal)
      if (request !== this.#searchRequest) return
      this.#searchResults = rows
      this.#searchNote = rows.some(row => !this.#actions.isBlocked(row.pubkey)) ? '' : 'No matching Nostr profiles found.'
    } catch {
      if (request === this.#searchRequest) this.#searchNote = 'The Nostr search relay could not be reached. Try again.'
    } finally {
      if (request === this.#searchRequest) { this.#searchRequest = undefined; this.render() }
    }
  }

  #publicPeople(): Person[] {
    return this.#searchResults.filter(row => !this.#actions.isBlocked(row.pubkey))
      .map(({ pubkey, name }) => ({ pubkey, name, section: 'nostr' }))
  }

  /** Redraw from the model. Cheap enough to call on every change. */
  render(): void {
    const model = this.#model()
    const profiles = this.#actions.profileSettings()
    const query = this.#query.value.trim().toLocaleLowerCase()
    if (!this.#actions.canSearchNostr()) this.resetSearch()
    const line = this.#actions.inboxLine()
    this.#line.replaceChildren()
    this.#line.hidden = !line
    if (line) {
      this.#line.append(document.createTextNode(line.text))
      if (line.action) {
        const run = line.action.run
        const button = this.#textButton(line.action.label, () => run())
        this.#line.append(' ', button)
      }
    }
    const local = [...model.contacts, ...model.following, ...model.conversations]
    const localKeys = new Set(local.map(person => person.pubkey))
    const publicPeople = this.#publicPeople(), publicKeys = new Set(publicPeople.map(person => person.pubkey))
    const exactKey = peopleSearchKey(query)
    const matches = (person: Person): boolean => !query
      || person.pubkey === exactKey || publicKeys.has(person.pubkey)
      || [person.name, person.chatName, person.address, npubEncode(person.pubkey)].some(value => value?.toLocaleLowerCase().includes(query))
    const byName = (a: Person, b: Person): number => {
      if (!a.name !== !b.name) return a.name ? -1 : 1
      return (a.name ?? a.pubkey).localeCompare(b.name ?? b.pubkey, undefined, { sensitivity: 'base' })
    }
    // A person is listed once, and Messages claims them first (C5, spec 5.2).
    const claimed = new Set<string>()
    const claim = (people: Person[]): Person[] => people.filter(person => matches(person) && !claimed.has(person.pubkey)).map(person => { claimed.add(person.pubkey); return person })
    const messagePeople = local.filter(person => person.last)
    const messages = claim(messagePeople.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)))
    const contacts = claim([...model.contacts, ...model.conversations, ...model.following.filter(person => person.chatName)].sort(byName))
    const following = claim(model.following.sort(byName))
    const pasted: Person[] = exactKey && !localKeys.has(exactKey) && !this.#actions.isBlocked(exactKey) ? [{ pubkey: exactKey, section: 'nostr' }] : []
    const found = claim([...pasted, ...publicPeople.filter(person => !localKeys.has(person.pubkey))])
    const sections: [string, Person[]][] = [['Messages', messages], ['Contacts', contacts], ['Following', following], ['On Nostr', found]]
    // Names for everyone listed, a batch at a time. The follow list is
    // public already, so asking about its people tells the relays nothing
    // new; the public profiles switch decides whether anything is asked.
    // Lookups switched off forget every profile, so ask again once back on.
    if (model.followStatus === 'off') this.#wanted.clear()
    else {
      const fresh = [...model.contacts, ...model.following].map(person => person.pubkey).filter(key => !this.#wanted.has(key))
      for (const key of fresh) this.#wanted.add(key)
      for (let i = 0; i < fresh.length; i += WANT_BATCH) this.#actions.want(fresh.slice(i, i + WANT_BATCH))
    }

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
    // The search row sits first, under the box, once there is a name to ask for.
    const searchQuery = peopleSearchQuery(query), askable = !!searchQuery && !exactKey && this.#actions.canSearchNostr()
    if (askable) children.push(this.#searchRow(searchQuery!, previous))
    const now = Date.now()
    for (const [name, list] of sections) {
      const followingNote = name === 'Following' ? this.#followingNote(model, query, profiles.available) : undefined
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
      if (name === 'Following') {
        let turnOn = head.querySelector<HTMLButtonElement>('button.peopleTurnOn')
        if (!turnOn) {
          turnOn = this.#textButton('Turn on public profiles', () => this.#actions.setPublicProfiles(true))
          turnOn.classList.add('peopleTurnOn')
          head.append(turnOn)
        }
        turnOn.hidden = !(model.followStatus === 'off' && profiles.available && !query)
      }
      children.push(head)
      for (const person of list) children.push(this.#row(person, previous.get(person.pubkey), now))
    }
    const focused = document.activeElement
    for (const row of [...this.#rows.children]) if (!children.includes(row as HTMLLIElement)) row.remove()
    children.forEach((row, index) => { if (this.#rows.children[index] !== row) this.#rows.insertBefore(row, this.#rows.children[index] ?? null) })
    if (focused instanceof HTMLElement && !focused.isConnected) this.#query.focus({ preventScroll: true })

    // One tab stop for the whole list: the chosen row, else the first.
    const buttons = [...this.#rows.querySelectorAll<HTMLButtonElement>('button[data-action="person"]')]
    const stop = buttons.find(button => button.closest<HTMLElement>('li')?.dataset.person === this.#selected) ?? buttons[0]
    for (const button of buttons) button.tabIndex = button === stop ? 0 : -1

    this.#empty.hidden = !!query || local.length > 0 || model.followStatus === 'loading'
    this.#status.textContent = this.#note || this.#searchNote
      || (query && !people.length && !askable ? 'No matching contacts or conversations.' : model.contactsNote ?? '')
    this.#status.hidden = !this.#status.textContent
    if (this.#selected && !people.some(person => person.pubkey === this.#selected)
      && !localKeys.has(this.#selected)) { this.#selected = undefined; this.#info = false }
    this.#paintPane()
  }

  /** Show this person (or nobody). */
  select(pubkey: string | undefined): void {
    if (pubkey !== this.#selected) this.#info = false
    this.#selected = pubkey
    this.#note = ''
    this.render()
  }

  /** Open a thread for a key that may not be listed yet, as if its npub had been pasted. */
  openKey(pubkey: string): void {
    this.#query.value = npubEncode(pubkey)
    // The pane goes on screen first: a thread marks read and takes focus only when shown.
    this.#actions.openDetail()
    this.select(pubkey)
  }

  /** Send the one-line note ahead of an invitation, in this person's thread. */
  async sendNote(person: Person, text: string): Promise<void> {
    await this.#thread.sendNote(this.#subject(person), text)
  }

  #searchRow(query: string, previous: Map<string, HTMLLIElement>): HTMLLIElement {
    const row = document.createElement('li')
    row.className = 'peopleSearchRow'
    void previous
    const button = document.createElement('button')
    button.type = 'button'
    button.id = 'peopleSearchNostr'
    button.disabled = !!this.#searchRequest
    const words = document.createElement('span')
    words.className = 'personName'
    words.textContent = `Search Nostr for “${query}”`
    const sub = document.createElement('span')
    sub.className = 'personSub'
    sub.textContent = 'Asks relay.ditto.pub'
    const text = document.createElement('span')
    text.className = 'personText'
    text.append(words, sub)
    button.append(icon('search'), text)
    button.addEventListener('click', event => { if (event.isTrusted) void this.#searchNostr() })
    row.append(button)
    return row
  }

  #followingNote(model: PeopleModel, query: string, profilesAvailable: boolean): string | undefined {
    if (query) return undefined
    if (model.followStatus === 'off') return profilesAvailable
      ? 'Turn on public profiles to see who you follow.'
      : 'Public profiles are paused while Nostr networking is off.'
    if (model.followStatus === 'loading' && !model.following.length) return 'Looking for the people you follow…'
    return undefined
  }

  #held(): boolean {
    return this.#rows.contains(document.activeElement) || this.#rows.matches(':hover')
  }

  #row(person: Person, existing: HTMLLIElement | undefined, now: number): HTMLLIElement {
    const row = existing ?? document.createElement('li')
    row.dataset.person = person.pubkey
    row.className = 'personRow'
    const button = row.querySelector<HTMLButtonElement>('button') ?? document.createElement('button')
    button.type = 'button'
    button.dataset.action = 'person'
    const chosen = person.pubkey === this.#selected
    if (chosen) button.setAttribute('aria-current', 'true')
    else button.removeAttribute('aria-current')
    const name = person.request ? shortNpub(person.pubkey) : person.name ?? shortNpub(person.pubkey)
    const when = person.last ? rowTime(person.last.at, now) : ''
    const sub = person.request ? 'Message request' : person.last ? preview(person) : subline(person)
    const unread = person.unread ?? 0
    button.setAttribute('aria-label', person.request ? [name, 'message request', when].filter(Boolean).join(', ')
      : [name, unread ? `${unread} unread` : '', when, sub].filter(Boolean).join(', '))
    button.onclick = () => {
      // Below 900 px the pane is on screen only once pushed, so push it before drawing.
      this.#actions.openDetail()
      this.select(person.pubkey)
    }
    const text = document.createElement('span')
    text.className = 'personText'
    const top = document.createElement('span')
    top.className = 'personTop'
    const title = document.createElement('span')
    title.className = 'personName'
    // The words in a span of their own: an ellipsis needs a block to end, and
    // the check mark beside a long name must stay in view.
    const words = document.createElement('span')
    words.className = 'personNameText'
    words.textContent = name
    title.append(words)
    if (person.checked) title.append(checkMark())
    top.append(title)
    if (when) {
      const time = document.createElement('span')
      time.className = 'personTime'
      time.textContent = when
      top.append(time)
    }
    text.append(top)
    if (sub || unread) {
      const bottom = document.createElement('span')
      bottom.className = 'personBottom'
      const second = document.createElement('span')
      second.className = 'personSub'
      second.textContent = sub
      bottom.append(second)
      if (unread) {
        const pill = document.createElement('span')
        pill.className = 'personUnread'
        pill.setAttribute('aria-hidden', 'true')
        pill.textContent = unread > 99 ? '99+' : String(unread)
        bottom.append(pill)
      }
      text.append(bottom)
    }
    const drawn = JSON.stringify([name, sub, when, unread, person.picture, person.checked, person.request])
    if (button.dataset.drawn !== drawn) {
      button.dataset.drawn = drawn
      button.replaceChildren(person.request ? personAvatar(person.pubkey, undefined, undefined, 'personAvatar') : avatar(person, 'personAvatar'), text)
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

  #back(): void {
    const key = this.#selected
    this.#actions.closeDetail()
    if (key) this.#rows.querySelector<HTMLButtonElement>(`li[data-person="${key}"] button`)?.focus()
  }

  #find(pubkey: string | undefined): Person | undefined {
    const model = this.#model()
    return [...model.contacts, ...model.following, ...model.conversations, ...this.#publicPeople()].find(entry => entry.pubkey === pubkey)
      ?? (pubkey && peopleSearchKey(this.#query.value.trim()) === pubkey ? { pubkey, section: 'nostr' as const } : undefined)
  }

  #subject(person: Person): ThreadSubject {
    const name = person.request ? shortNpub(person.pubkey) : person.name ?? shortNpub(person.pubkey)
    return {
      pubkey: person.pubkey, name, ...(person.request || !person.picture ? {} : { picture: person.picture }),
      ...(person.address && !person.request ? { address: person.address } : {}),
      request: !!person.request, hasChat: !!this.#actions.privateChat(person.pubkey),
      openChat: () => this.#actions.privateChat(person.pubkey)?.open(),
      invite: opener => this.#openInvite(person, opener),
      info: opener => { this.#info = true; this.#paintPane(); void opener; this.#pane.querySelector<HTMLElement>('#peopleInfoTitle')?.focus() },
      block: () => this.#block(person),
    }
  }

  #block(person: Person): void {
    const name = person.name ?? shortNpub(person.pubkey)
    try {
      this.#actions.block(person.pubkey)
      // They leave the list, so the page closes and says where they went.
      this.#note = `${person.request ? shortNpub(person.pubkey) : name} is blocked on this device. Settings › Privacy lists who you have blocked.`
      this.#selected = undefined
      this.#actions.closeDetail()
    } catch (error) {
      this.#note = error instanceof Error ? error.message : String(error)
    }
    this.render()
  }

  #paintPane(): void {
    const person = this.#find(this.#selected)
    const shared = person ? this.#actions.sharedRooms(person.pubkey) : []
    const sent = person ? this.#actions.sentInvitations(person.pubkey) : []
    const check = person ? this.#actions.check(person) : undefined
    // Only what is drawn goes in: a day word changes at midnight, not every tick.
    const today = Date.now()
    const key = person ? JSON.stringify([person.pubkey, person.name, person.picture, person.address, person.request, person.checked, person.tier, this.#info,
      this.#actions.blockedReason(person.pubkey), this.#busy, this.#note, this.#actions.privateChat(person.pubkey)?.label,
      check, shared.map(room => [room.roomId, room.label]), sent.map(invite => [invite.roomId, invite.label, invite.joined, invite.at === undefined ? '' : dayWords(invite.at, today)])]) : 'none'
    if (!person) {
      this.#painted = key
      if (this.#pane.querySelector('.peopleBlank')) return
      const blank = document.createElement('div')
      blank.className = 'peopleBlank'
      const line = document.createElement('p')
      line.textContent = 'Pick someone to message or call.'
      blank.append(line)
      this.#pane.replaceChildren(blank)
      return
    }
    if (key === this.#painted && this.#pane.contains(this.#thread.element)) { this.#thread.show(this.#subject(person)); return }
    this.#painted = key
    const subject = this.#subject(person)
    const frame = document.createElement('div')
    frame.className = 'peopleFrame'
    frame.dataset.info = this.#info ? 'open' : 'closed'
    const main = document.createElement('div')
    main.className = 'peopleMain'
    main.append(this.#header(person, subject), this.#thread.element)
    frame.append(main)
    if (this.#info) frame.append(this.#infoPanel(person, subject, shared, sent, check))
    const focusInside = this.#pane.contains(document.activeElement) ? document.activeElement : undefined
    const keep = focusInside === this.#thread.field
    this.#pane.replaceChildren(frame)
    this.#thread.show(subject)
    if (keep) this.#thread.field.focus({ preventScroll: true })
  }

  #header(person: Person, subject: ThreadSubject): HTMLElement {
    const header = document.createElement('header')
    header.className = 'peopleHeader'
    const iconButton = (label: string, glyph: IconName, run: (button: HTMLButtonElement) => void, extra = '') => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `iconButton ${extra}`.trim()
      button.setAttribute('aria-label', label)
      button.dataset.tip = label
      button.append(icon(glyph))
      button.addEventListener('click', event => { if (event.isTrusted) run(button) })
      return button
    }
    const back = iconButton('Back to people', 'back', () => this.#back(), 'peopleBack barBack')
    const name = document.createElement('h2')
    name.id = 'peoplePaneTitle'
    name.tabIndex = -1
    const nameButton = document.createElement('button')
    nameButton.type = 'button'
    nameButton.className = 'peopleHeaderName'
    nameButton.textContent = subject.name
    nameButton.addEventListener('click', event => { if (event.isTrusted) subject.info(nameButton) })
    name.append(nameButton)
    const sub = document.createElement('p')
    sub.className = 'peopleHeaderSub'
    sub.textContent = person.request ? 'Message request' : 'Nostr messages'
    const words = document.createElement('div')
    words.className = 'peopleHeaderWords'
    words.append(name, sub)
    const chat = this.#actions.privateChat(person.pubkey)
    const callable = !!chat || !this.#actions.blockedReason(person.pubkey)
    const actions = document.createElement('div')
    actions.className = 'peopleHeaderActions'
    if (callable) {
      actions.append(iconButton('Voice call', 'phone', () => this.#run(this.#actions.call(person, false)), 'peopleCall'),
        iconButton('Video call', 'video', () => this.#run(this.#actions.call(person, true)), 'peopleCall'))
    }
    const invite = iconButton('Invite to KithMoot', 'personAdd', button => this.#openInvite(person, button), 'peopleInviteButton')
    invite.id = 'peopleInvite'
    const more = iconButton('More', 'moreVert', () => {}, 'peopleMore')
    more.id = 'peopleMore'
    actions.append(invite, more)
    header.append(back, personAvatar(person.pubkey, person.request ? undefined : person.name, person.request ? undefined : person.picture, 'peopleHeaderAvatar'), words, actions)
    this.#wireMore(person, subject, more, callable, chat)
    return header
  }

  #run(promise: Promise<string | undefined>): void {
    this.#busy = true
    void promise.then(note => { this.#note = note ?? '' }, error => { this.#note = error instanceof Error ? error.message : String(error) })
      .finally(() => { this.#busy = false; this.render() })
  }

  #wireMore(person: Person, subject: ThreadSubject, opener: HTMLButtonElement, callable: boolean, chat: { label: string; open(): void } | undefined): void {
    const menu = document.createElement('div')
    menu.id = 'peopleMoreMenu'
    menu.setAttribute('aria-label', `More for ${subject.name}`)
    document.getElementById('peopleMoreMenu')?.remove()
    document.body.append(menu)
    const trusted = trustedClicks(menu)
    const handle = wireMenu(opener, menu, { beforeOpen: () => {
      const compact = window.matchMedia('(max-width: 599px)').matches
      const huge = document.documentElement.dataset.textSize === 'huge'
      const reason = this.#actions.blockedReason(person.pubkey)
      menuGroups(menu, [
        m => {
          menuItem(m, 'Contact info', () => { if (trusted()) subject.info(opener) }, { action: 'info' })
          if (chat) menuItem(m, 'Open private chat', () => { if (trusted()) chat.open() }, { action: 'open-chat' })
          if ((huge || compact) && callable) {
            menuItem(m, 'Voice call', () => { if (trusted()) this.#run(this.#actions.call(person, false)) }, { action: 'voice' })
            menuItem(m, 'Video call', () => { if (trusted()) this.#run(this.#actions.call(person, true)) }, { action: 'video' })
          }
          if (compact) menuItem(m, 'Invite to KithMoot', () => { if (trusted()) this.#openInvite(person, opener) }, { action: 'invite' })
        },
        m => {
          const words = menuItem(m, 'Check words together', () => {
            if (trusted()) this.#run(this.#actions.checkWords(person))
          }, { action: 'check-words' })
          if (reason) { words.disabled = true; words.title = reason }
          menuItem(m, 'Copy public key', () => {
            if (!trusted()) return
            void navigator.clipboard?.writeText(npubEncode(person.pubkey)).then(() => { this.#say('Public key copied.') }, () => { this.#say('Copying is not allowed here.') })
          }, { action: 'copy-key' })
        },
        m => { menuItem(m, `Block ${subject.name}`, () => { if (trusted()) this.#block(person) }, { danger: true, action: 'block' }) },
      ])
    }, sheet: '(max-width: 599px)' })
    this.#moreMenu = { handle, menu }
  }

  #openInvite(person: Person, opener: HTMLElement): void {
    const name = person.request ? shortNpub(person.pubkey) : person.name ?? shortNpub(person.pubkey)
    const options = this.#actions.inviteOptions(person)
    document.getElementById('peopleInviteMenu')?.remove()
    const menu = document.createElement('div')
    menu.id = 'peopleInviteMenu'
    menu.setAttribute('aria-label', `Invite ${name} to KithMoot`)
    const trusted = trustedClicks(menu)
    const choice = (parent: HTMLElement, label: string, second: string, enabled: boolean, reason: string | undefined, run: () => void, action: string) => {
      const item = menuItem(parent, label, () => { if (trusted()) run() }, { action })
      const line = document.createElement('span')
      line.className = 'menuLine'
      line.textContent = enabled ? second : reason ?? second
      item.append(line)
      if (!enabled) { item.disabled = true; item.setAttribute('aria-disabled', 'true') }
    }
    menuGroups(menu, [
      m => {
        const heading = document.createElement('p')
        heading.className = 'menuHeading'
        heading.textContent = `Invite ${name} to KithMoot`
        m.append(heading)
      },
      m => {
        const existing = options.privateChat.existing
        choice(m, 'A private chat', existing ? 'You already have one. Open it.' : `Starts a KithMoot chat with ${name}`,
          options.privateChat.enabled, options.privateChat.reason,
          () => this.#run(this.#actions.invitePrivateChat(person, () => this.sendNote(person, INVITE_NOTE))), 'private-chat')
        choice(m, 'A room…', 'Choose one of your rooms', options.room.enabled, options.room.reason,
          () => this.#run(this.#actions.invite(person, () => this.sendNote(person, INVITE_NOTE))), 'room')
      },
      m => {
        const note = document.createElement('p')
        note.className = 'menuNote note'
        note.textContent = `${name} gets it as a Nostr message with a link to join.`
        m.append(note)
      },
    ])
    document.body.append(menu)
    const handle = wireMenu(opener, menu, { sheet: '(max-width: 599px)' })
    // The menu is built on the click and opened here; the declarative invoker would toggle it shut again.
    opener.removeAttribute('popovertarget')
    menu.addEventListener('toggle', event => { if ((event as ToggleEvent).newState === 'closed') queueMicrotask(() => menu.remove()) })
    this.#inviteMenu = { handle, menu }
    handle.open()
  }

  #infoPanel(person: Person, subject: ThreadSubject, shared: SharedRoom[], sent: SentInvitation[], check: ReturnType<PeopleActions['check']> | undefined): HTMLElement {
    const panel = document.createElement('aside')
    panel.className = 'peopleInfo'
    panel.setAttribute('aria-labelledby', 'peopleInfoTitle')
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'quiet peopleInfoBack'
    back.textContent = `Back to ${subject.name}`
    back.addEventListener('click', event => { if (event.isTrusted) { this.#info = false; this.#paintPane(); this.#thread.field.focus({ preventScroll: true }) } })
    const card = document.createElement('div')
    card.className = 'contactCard'
    const heading = document.createElement('h2')
    heading.id = 'peopleInfoTitle'
    heading.tabIndex = -1
    heading.textContent = subject.name
    const meta = document.createElement('p')
    meta.className = 'contactMeta'
    const sub = subline(person)
    if (person.checked) meta.append(checkMark())
    if (sub && !person.last) meta.append(document.createTextNode(sub))
    const npub = npubEncode(person.pubkey)
    const key = document.createElement('span')
    key.className = 'contactKey'
    key.textContent = shortNpub(person.pubkey)
    key.title = npub
    meta.append(key)
    const note = document.createElement('p')
    note.id = 'peopleActionNote'
    note.className = 'note'
    note.setAttribute('role', 'status')
    note.textContent = this.#note
    card.append(personAvatar(person.pubkey, person.request ? undefined : person.name, person.request ? undefined : person.picture, 'contactAvatar'), heading, meta, note)
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
    const today = Date.now()
    if (shared.length) {
      const list = contactList('peopleSharedRooms', 'Rooms you share')
      for (const room of shared) {
        const open = contactLinkButton(room.label, room.open)
        open.prepend(personAvatar(room.roomId, room.label, undefined, 'contactRoomAvatar'))
        list.items.append(listItem(open))
      }
      card.append(list.section)
    }
    if (sent.length) {
      const list = contactList('peopleSentInvitations', 'Invitations')
      for (const invite of sent) {
        const state = `You invited ${subject.name} · ${invite.joined ? 'Joined' : 'Sent, not joined yet'}`
        const day = invite.at === undefined ? '' : dayWords(invite.at, today)
        const open = contactLinkButton(invite.label, invite.open, state, day)
        open.prepend(icon('personAdd'))
        open.setAttribute('aria-label', [invite.label, state, day].filter(Boolean).join(', '))
        list.items.append(listItem(open))
      }
      card.append(list.section)
    }
    if (check && !person.request) {
      const section = document.createElement('div')
      section.className = 'contactSection'
      const reason = this.#actions.blockedReason(person.pubkey)
      const compare = contactLinkButton('Check words together', () => this.#run(this.#actions.checkWords(person)), check.line)
      compare.id = 'peopleCheckWords'
      compare.prepend(icon('shield'))
      compare.classList.add(`check-${check.status}`)
      compare.disabled = this.#busy || !!reason
      compare.setAttribute('aria-label', `Check words together, ${check.line}`)
      section.append(compare)
      card.append(section)
    }
    // Block, last (spec §6.1). Never published; they are not told.
    const blockSection = document.createElement('div')
    blockSection.className = 'contactSection'
    const block = document.createElement('button')
    block.type = 'button'
    block.id = 'peopleBlock'
    block.className = 'contactLink danger'
    const blockText = document.createElement('span')
    blockText.className = 'contactLinkText'
    const blockTitle = document.createElement('span')
    blockTitle.className = 'contactLinkTitle'
    blockTitle.textContent = `Block ${subject.name}`
    const blockSub = document.createElement('span')
    blockSub.className = 'contactLinkSub'
    blockSub.textContent = 'They can’t invite you or ask to join your rooms on this device. They aren’t told.'
    blockText.append(blockTitle, blockSub)
    block.append(blockText)
    block.disabled = this.#busy
    block.addEventListener('click', event => { if (event.isTrusted) this.#block(person) })
    blockSection.append(block)
    card.append(blockSection)
    panel.append(back, card)
    return panel
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
    button.addEventListener('click', event => { if (event.isTrusted) run(button) })
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


/** The one line sent ahead of a new invitation (P8). */
export const INVITE_NOTE = "I've invited you to a private chat on KithMoot."

/** A click that came from a person, for menu items that sign, send or block:
 *  menu.ts closes the menu and runs the item from the click handler, so the
 *  last click on the menu is the one to ask. */
function trustedClicks(menu: HTMLElement): () => boolean {
  let trusted = false
  menu.addEventListener('click', event => { trusted = event.isTrusted }, true)
  menu.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') trusted = event.isTrusted }, true)
  return () => trusted
}

/** The time at the right of a list row: the clock today, else the day. */
function rowTime(at: number, now: number): string {
  return dayWords(at, now) === 'Today' ? timeWords(at) : dayWords(at, now)
}

/** The line under a name in the Messages section: the newest words. */
function preview(person: Person): string {
  const last = person.last!
  const text = last.text.replace(/\s+/g, ' ').trim()
  return last.mine ? `You: ${text}` : text
}

/** A titled list in the contact's pane. */
function contactList(id: string, heading: string): { section: HTMLElement; items: HTMLUListElement } {
  const section = document.createElement('section')
  section.className = 'contactSection'
  const title = document.createElement('h3')
  title.id = `${id}Title`
  title.textContent = heading
  const items = document.createElement('ul')
  items.id = id
  items.className = 'contactRooms'
  items.setAttribute('aria-labelledby', title.id)
  section.append(title, items)
  return { section, items }
}

function listItem(content: HTMLElement): HTMLLIElement {
  const item = document.createElement('li')
  item.append(content)
  return item
}

/** A row that opens a room: its name, an optional line under it, and a day
 *  or a chevron on the right. */
function contactLinkButton(label: string, open: () => void, sub?: string, meta?: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'contactLink'
  const text = document.createElement('span')
  text.className = 'contactLinkText'
  const title = document.createElement('span')
  title.className = 'contactLinkTitle'
  title.textContent = label
  text.append(title)
  if (sub) {
    const line = document.createElement('span')
    line.className = 'contactLinkSub'
    line.textContent = sub
    text.append(line)
  }
  button.append(text)
  if (meta) {
    const day = document.createElement('span')
    day.className = 'contactLinkMeta'
    day.textContent = meta
    button.append(day)
  } else {
    button.append(icon('chevron'))
  }
  button.addEventListener('click', () => open())
  return button
}

/** A day for the right of a row, as the Chats list says it: "Today",
 *  "Yesterday", a weekday within the week, else the date, with the year
 *  outside this one. */
export function dayWords(at: number, now: number = Date.now()): string {
  const then = new Date(at * 1000)
  const today = new Date(now)
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((midnight(today) - midnight(then)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: 'short' })
  return then.toLocaleDateString(undefined, then.getFullYear() === today.getFullYear()
    ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

export function shortNpub(pubkey: string): string {
  const npub = npubEncode(pubkey)
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`
}

/** The line under a name, the same on web and Android: "Kith · checked"
 *  when Signet shares them, else where the contact came from; for someone
 *  followed, their Nostr address once checked, else nothing. */
function subline(person: Person): string {
  if (person.section === 'nostr') return person.name ? shortNpub(person.pubkey) : ''
  if (person.section === 'conversations') return person.chatName ? 'Private chat' : 'Nostr messages'
  if (person.section === 'following') return person.chatName ? 'Private chat' : person.address ?? ''
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
  // A nameless person is Somebody everywhere, so their picture says S, not
  // the first letter of a key.
  span.textContent = avatarInitial(name ?? 'Somebody')
  if (picture) {
    const image = document.createElement('img')
    image.alt = ''
    image.loading = 'lazy'
    image.referrerPolicy = 'no-referrer'
    image.addEventListener('error', () => image.remove(), { once: true })
    span.append(image)
    setPeoplePicture(image, picture)
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
