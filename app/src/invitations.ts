import './invitations.css'
import { menuItem, wireMenu } from './menu.js'
import { personAvatar, shortNpub } from './people.js'

/**
 * Invitations at the top of Chats (spec §6.3): private chats somebody has
 * asked this account for, each with Decline and Accept. The section is the
 * shell's `#chatInvitations`; this fills it and shows it only while any wait.
 *
 * Only private-chat requests arrive here. The contact inbox accepts nothing
 * else (`readContactInvitation`), so an invitation to a group room still
 * arrives inside the private chat, as the in-room sealed invite.
 */
export interface WaitingInvitation {
  id: string
  /** Who sent it. */
  pubkey: string
  /** From `inviterIdentity`; a stranger has none and is shown by key. */
  name?: string
  picture?: string
  /** The sender's clock, in seconds. */
  sentAt: number
}

export interface InvitationActions {
  accept(id: string): Promise<void>
  decline(id: string): Promise<void>
  /** Decline, and block the sender on this device. They are not told. */
  declineAndBlock(id: string): Promise<void>
  /** "2 minutes ago" and so on, worded as everywhere else in the app. */
  when(sentAt: number): string
}

export interface InviterFacts {
  /** The name Signet shares for this key, if it is a Signet contact. */
  signetName?: string
  /** The name on a contact card saved on this device. */
  cardName?: string
  /** A Signet contact, a contact card or somebody this account follows. */
  known: boolean
  /** Their public profile, when lookups are on. */
  profile?: { name?: string; picture?: string }
}

/** Who an invitation is from, as far as this device may say. A name a person
 *  gives themselves in their public profile is used only for somebody you
 *  already know or follow, as People does; a stranger is shown by their key,
 *  so nobody can arrive calling themselves "Mum". */
export function inviterIdentity(facts: InviterFacts): { name?: string; picture?: string } {
  const name = facts.signetName || facts.cardName || (facts.known ? facts.profile?.name : undefined)
  const picture = facts.known ? facts.profile?.picture : undefined
  return { ...(name ? { name } : {}), ...(picture ? { picture } : {}) }
}

export function invitationTitle(invitation: Pick<WaitingInvitation, 'pubkey' | 'name'>): string {
  return `${invitation.name ?? shortNpub(invitation.pubkey)} invited you to a private chat`
}

export class InvitationsView {
  readonly #section: HTMLElement
  readonly #model: () => WaitingInvitation[]
  readonly #actions: InvitationActions
  readonly #list: HTMLUListElement
  readonly #status: HTMLParagraphElement
  readonly #busy = new Set<string>()
  #error = ''

  constructor(section: HTMLElement, model: () => WaitingInvitation[], actions: InvitationActions) {
    this.#section = section
    this.#model = model
    this.#actions = actions
    section.classList.add('chatInvitations')
    const heading = document.createElement('h3')
    heading.textContent = 'Invitations'
    this.#list = document.createElement('ul')
    this.#status = document.createElement('p')
    this.#status.className = 'note'
    this.#status.setAttribute('role', 'status')
    section.replaceChildren(heading, this.#list, this.#status)
  }

  /** Redraws in place: a row and its buttons are made once and only their
   *  text changes, so a button is never swapped out from under a click. */
  render(): void {
    const waiting = this.#model()
    if (!waiting.length) this.#error = ''
    const rows = new Map([...this.#list.children].map(row => [(row as HTMLElement).dataset.invitation, row as HTMLLIElement]))
    let index = 0
    for (const invitation of waiting) {
      const row = rows.get(invitation.id) ?? this.#row(invitation.id)
      rows.delete(invitation.id)
      this.#fill(row, invitation)
      if (this.#list.children[index] !== row) this.#list.insertBefore(row, this.#list.children[index] ?? null)
      index++
    }
    for (const [id, row] of rows) { row.remove(); if (id) this.#busy.delete(id) }
    this.#status.textContent = this.#error
    this.#status.hidden = !this.#error
    this.#section.hidden = !waiting.length && !this.#error
  }

  #row(id: string): HTMLLIElement {
    const row = document.createElement('li')
    row.className = 'invitation'
    row.dataset.invitation = id
    const text = document.createElement('span')
    text.className = 'invitationText'
    const title = document.createElement('span')
    title.className = 'invitationTitle'
    const sub = document.createElement('span')
    sub.className = 'invitationSub'
    text.append(title, sub)
    const decline = document.createElement('button')
    decline.type = 'button'
    decline.className = 'tonal'
    decline.dataset.action = 'decline'
    decline.textContent = 'Decline'
    decline.addEventListener('click', () => this.#answer(id, 'decline'))
    const accept = document.createElement('button')
    accept.type = 'button'
    accept.className = 'primary'
    accept.dataset.action = 'accept'
    accept.textContent = 'Accept'
    accept.addEventListener('click', () => this.#answer(id, 'accept'))
    // The row's ⋯ (spec §6.3): Decline and block. Two deliberate presses, so
    // no confirmation; Settings › Privacy lists blocks and undoes them.
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'rowMenu'
    more.textContent = '⋯'
    more.dataset.action = 'more'
    const menu = document.createElement('div')
    menu.id = `invitationMenu-${id}`
    menu.className = 'rowMenuPopover'
    menuItem(menu, 'Decline and block', () => this.#answer(id, 'block'), { danger: true, action: 'decline-block' })
    wireMenu(more, menu)
    const answers = document.createElement('span')
    answers.className = 'invitationAnswers'
    answers.append(decline, accept, more)
    row.append(document.createElement('span'), text, answers, menu)
    return row
  }

  #fill(row: HTMLLIElement, invitation: WaitingInvitation): void {
    const look = JSON.stringify([invitation.pubkey, invitation.name ?? '', invitation.picture ?? ''])
    if (row.dataset.look !== look) {
      row.dataset.look = look
      row.firstElementChild!.replaceWith(personAvatar(invitation.pubkey, invitation.name, invitation.picture, 'personAvatar'))
    }
    const who = invitation.name ?? shortNpub(invitation.pubkey)
    row.querySelector('.invitationTitle')!.textContent = invitationTitle(invitation)
    row.querySelector('.invitationSub')!.textContent = `Sealed for you · ${this.#actions.when(invitation.sentAt)}`
    const busy = this.#busy.has(invitation.id)
    for (const button of row.querySelectorAll<HTMLButtonElement>('.invitationAnswers > button')) {
      button.disabled = busy
      button.setAttribute('aria-label', button.dataset.action === 'more' ? `More for the invitation from ${who}`
        : `${button.dataset.action === 'accept' ? 'Accept' : 'Decline'} private chat with ${who}`)
    }
    row.querySelector('[data-action="decline-block"] .menuLabel')!.textContent = `Decline and block ${who}`
  }

  async #answer(id: string, answer: 'accept' | 'decline' | 'block'): Promise<void> {
    if (this.#busy.has(id)) return
    this.#busy.add(id); this.#error = ''; this.render()
    try {
      await (answer === 'accept' ? this.#actions.accept(id) : answer === 'block' ? this.#actions.declineAndBlock(id) : this.#actions.decline(id))
    } catch (error) {
      this.#error = error instanceof Error && error.message ? error.message : answer === 'accept' ? 'That chat could not be opened. Try again.' : 'That invitation could not be cleared. Try again.'
    } finally {
      this.#busy.delete(id); this.render()
    }
  }
}
