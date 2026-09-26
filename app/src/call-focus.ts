import './call-focus.css'
import {
  UnreadCounter, callFirst, chatPanelOpen, loadChatPanel, saveChatPanel, toolbarMove, unreadAnnouncement,
} from './call-focus-model.js'

/**
 * The call first, on a wide screen. See call-focus-model.ts for when, and
 * call-focus.css for the layout.
 *
 * Nothing here creates or moves a `<video>` or `<audio>`. The existing call
 * controls keep their ids, listeners and `aria-pressed`, and stay where
 * they are in `#deviceControls`, which becomes the control bar; the bar's
 * own additions (View, Chat, Full screen) are built once and shown only in
 * this layout. Three small elements that belong in the bar but live
 * elsewhere - the view switcher, the "Speaking" line and the microphone
 * line - are moved in while it is on and put back exactly where they were
 * when it goes.
 *
 * `html[data-call-first]` switches the layout, and `html[data-call-chat]`
 * says whether the conversation panel beside the stage is open.
 */

export interface CallFocus {
  /** This device is on the call in the room on screen, or not. */
  setOnCall(on: boolean): void
  /** The messages from other people in the conversation on screen, for the
   *  unread count on the Chat button. `scope` names the room and
   *  conversation, so a change of either starts the count again. `agentIds`
   *  names which of `ids` are an agent's message that reached this person,
   *  shown in a badge of its own - see `UnreadCounter.agents`. */
  noteMessages(scope: string, ids: readonly string[], agentIds?: readonly string[]): void
}

/** The parts of the conversation, wherever they are: wrapped in
 *  `#chatDrawer` in the installed window, loose in `#roomArea` elsewhere. */
const CHAT_REGION = '#chatDrawer, #roomArea > :is(#conversationNav, .conversationTools, #approvals, #chatViewport, #outbox, #readOnlyNote, #chatForm, #attachStaged, #attachPanel)'

/** The bar's buttons, in the bar, in the order arrow keys walk them once
 *  sorted by where they are drawn. */
const BAR_ITEMS = ':scope > .toggles > button, :scope > .callHead > #leaveCall, #callViewMenu > summary, #callExtras > summary, .callBarEnd > button'

interface Moved { el: HTMLElement; mark: Comment }

const ICON = (path: string): string => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`
const FULL_SCREEN_ICON = ICON('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5')
const EXIT_FULL_SCREEN_ICON = ICON('M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5')

export function installCallFocus(storage: Storage = localStorage): CallFocus {
  const root = document.documentElement
  const room = document.getElementById('roomArea')!
  const controls = document.getElementById('deviceControls')!
  const bar = document.querySelector<HTMLElement>('#roomArea > .roomBar')
  const extras = document.getElementById('callExtras') as HTMLDetailsElement | null

  let onCall = false
  let active = false
  let remembered = loadChatPanel(storage)
  let chatOpen = chatPanelOpen(remembered, window.innerWidth)
  const unread = new UnreadCounter()
  let moved: Moved[] = []

  // --- What the bar adds ----------------------------------------------------

  const status = document.createElement('div')
  status.className = 'callBarStatus callBarOnly'

  const viewMenu = document.createElement('details')
  viewMenu.id = 'callViewMenu'
  viewMenu.className = 'callBarMenu callBarOnly'
  const viewSummary = document.createElement('summary')
  viewSummary.textContent = 'View'
  viewSummary.setAttribute('aria-label', 'Call view')
  const viewPopover = document.createElement('div')
  viewPopover.id = 'callViewPopover'
  viewPopover.className = 'callBarPopover'
  viewMenu.append(viewSummary, viewPopover)

  const end = document.createElement('div')
  end.className = 'callBarEnd callBarOnly'
  const chat = document.createElement('button')
  chat.type = 'button'
  chat.id = 'callChatToggle'
  chat.className = 'callBarButton'
  chat.setAttribute('aria-controls', document.getElementById('chatDrawer') ? 'chatDrawer' : 'chatLog')
  const chatWord = document.createElement('span')
  chatWord.textContent = 'Chat'
  const badge = document.createElement('span')
  badge.className = 'callChatUnread'
  badge.setAttribute('aria-hidden', 'true')
  badge.hidden = true
  // An agent's tag, in the agent colour used everywhere else, beside the
  // people badge - or alone, when there is nothing from a person to say.
  const agentBadge = document.createElement('span')
  agentBadge.className = 'callChatUnreadAgent'
  agentBadge.setAttribute('aria-hidden', 'true')
  agentBadge.hidden = true
  chat.append(chatWord, badge, agentBadge)
  const full = document.createElement('button')
  full.type = 'button'
  full.id = 'callFullscreen'
  full.className = 'callBarButton callBarIcon'
  // A picture of the four corners, the way every video app draws it; the
  // name is for everybody who cannot see it.
  full.setAttribute('aria-label', 'Full screen')
  full.title = 'Full screen'
  full.innerHTML = FULL_SCREEN_ICON
  full.setAttribute('aria-pressed', 'false')
  full.hidden = !document.fullscreenEnabled
  end.append(chat, full)

  const announce = document.createElement('p')
  announce.id = 'callChatAnnounce'
  announce.className = 'sr-only'
  announce.setAttribute('aria-live', 'polite')

  controls.prepend(status)
  if (extras?.parentElement === controls) extras.before(viewMenu)
  else controls.append(viewMenu)
  controls.append(end, announce)

  // --- The layout -------------------------------------------------------------

  function evaluate(): void {
    const next = callFirst({
      width: window.innerWidth,
      height: window.innerHeight,
      onCall,
      docked: root.hasAttribute('data-call-docked'),
      pane: root.dataset.callPane,
    })
    if (remembered === undefined) chatOpen = chatPanelOpen(undefined, window.innerWidth)
    if (next !== active) {
      active = next
      if (active) enter()
      else leave()
    }
    if (active) {
      renderChat()
      measure()
    }
  }

  function enter(): void {
    const focused = document.activeElement
    root.setAttribute('data-call-first', '')
    controls.setAttribute('role', 'toolbar')
    controls.setAttribute('aria-label', 'Call controls')
    move(document.getElementById('speakingNow'), status)
    move(document.getElementById('micIndicator'), status)
    move(document.getElementById('callView'), viewPopover)
    refocus(focused)
    // Anything that arrived while the chat was on screen has been seen.
    unread.read()
  }

  function leave(): void {
    const focused = document.activeElement
    root.removeAttribute('data-call-first')
    root.removeAttribute('data-call-chat')
    room.style.removeProperty('--call-first-top')
    controls.removeAttribute('role')
    controls.removeAttribute('aria-label')
    viewMenu.open = false
    if (extras) extras.open = false
    for (const { el, mark } of moved.reverse()) if (mark.isConnected) mark.replaceWith(el)
    moved = []
    refocus(focused)
    if (document.fullscreenElement === room) void document.exitFullscreen().catch(() => {})
    // Back to the room's own layout: the whole conversation is on screen.
    unread.read()
    renderBadge()
  }

  function move(el: HTMLElement | null, into: HTMLElement): void {
    if (!el || into.contains(el)) return
    const mark = document.createComment(`call-focus: #${el.id}`)
    el.replaceWith(mark)
    into.append(el)
    moved.push({ el, mark })
  }

  /** Moving an element drops focus from inside it. */
  function refocus(was: Element | null): void {
    if (was instanceof HTMLElement && was !== document.activeElement && was.isConnected && document.activeElement === document.body) {
      was.focus({ preventScroll: true })
    }
  }

  /** Where the stage starts: under the room bar. Only the ordinary build
   *  places the stage by number; the installed window's panels are a row. */
  function measure(): void {
    if (!bar) return
    const top = Math.max(0, Math.round(bar.getBoundingClientRect().bottom - room.getBoundingClientRect().top))
    const value = `${top}px`
    if (room.style.getPropertyValue('--call-first-top') !== value) room.style.setProperty('--call-first-top', value)
  }

  // --- The chat panel ---------------------------------------------------------

  function renderChat(): void {
    const state = chatOpen ? 'open' : 'closed'
    if (root.dataset.callChat !== state) root.dataset.callChat = state
    chat.setAttribute('aria-expanded', String(chatOpen))
    renderBadge()
  }

  function renderBadge(): void {
    const agents = unread.agents
    const people = unread.count - agents
    badge.hidden = people === 0
    badge.textContent = people > 99 ? '99+' : String(people)
    agentBadge.hidden = agents === 0
    agentBadge.textContent = agents > 99 ? '99+' : String(agents)
    const parts = [people > 0 ? `${people} unread` : undefined, agents > 0 ? `${agents} from agents` : undefined].filter((p) => p !== undefined)
    const label = parts.length === 0 ? 'Chat' : `Chat, ${parts.join(', ')}`
    if (chat.getAttribute('aria-label') !== label) chat.setAttribute('aria-label', label)
  }

  function setChatOpen(open: boolean): void {
    chatOpen = open
    remembered = open
    saveChatPanel(storage, open)
    if (open) {
      unread.read()
      announce.textContent = ''
    }
    renderChat()
  }

  chat.addEventListener('click', () => {
    const focusWasInChat = document.activeElement?.closest(CHAT_REGION)
    setChatOpen(!chatOpen)
    if (chatOpen) {
      // Opened to say something, the way every call app's chat opens.
      const input = document.getElementById('chatInput') as HTMLTextAreaElement | null
      requestAnimationFrame(() => {
        if (input && !input.disabled && input.getClientRects().length > 0) input.focus({ preventScroll: true })
      })
    } else if (focusWasInChat) chat.focus()
  })

  // --- Full screen ------------------------------------------------------------

  full.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void room.requestFullscreen?.().catch(() => {})
  })
  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement === room
    full.setAttribute('aria-pressed', String(on))
    full.innerHTML = on ? EXIT_FULL_SCREEN_ICON : FULL_SCREEN_ICON
    full.title = on ? 'Leave full screen (Escape)' : 'Full screen'
    root.toggleAttribute('data-call-fullscreen', on)
    evaluate()
  })

  // --- The bar, from the keyboard ----------------------------------------------

  function items(): HTMLElement[] {
    return [...controls.querySelectorAll<HTMLElement>(BAR_ITEMS)]
      .filter(item => item.getClientRects().length > 0 && !(item as HTMLButtonElement).disabled)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
  }

  controls.addEventListener('keydown', event => {
    if (!active || event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target as HTMLElement
    if (event.key === 'Escape') {
      const menu = target.closest<HTMLDetailsElement>('#callViewMenu, #callExtras')
      if (menu?.open) {
        event.preventDefault()
        menu.open = false
        menu.querySelector<HTMLElement>(':scope > summary')?.focus()
      }
      return
    }
    const list = items()
    const index = list.indexOf(target)
    if (index === -1) return
    const next = toolbarMove(event.key, index, list.length)
    if (next === undefined) return
    event.preventDefault()
    list[next].focus()
  })

  // Choosing a view is the whole errand: the menu goes, and focus goes
  // back to where it came from. The options below it stay open.
  viewPopover.addEventListener('click', event => {
    if (!(event.target as Element).closest('.callViewChoice button')) return
    viewMenu.open = false
    viewSummary.focus({ preventScroll: true })
  })

  // One menu open at a time, and a click elsewhere puts it away.
  const menus = [viewMenu, extras].filter((menu): menu is HTMLDetailsElement => menu !== null)
  for (const menu of menus) {
    menu.addEventListener('toggle', () => {
      if (!active || !menu.open) return
      for (const other of menus) if (other !== menu) other.open = false
    })
  }
  document.addEventListener('pointerdown', event => {
    if (!active) return
    for (const menu of menus) if (menu.open && !menu.contains(event.target as Node)) menu.open = false
  }, true)

  // Escape in the conversation goes back to the bar, once nothing in the
  // conversation itself wanted it: the message list and the composer both
  // use Escape first, and say so with `preventDefault`.
  document.addEventListener('keydown', event => {
    if (!active || event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
    const target = event.target as Element | null
    if (!target?.closest(CHAT_REGION) || target.closest('dialog')) return
    event.preventDefault()
    chat.focus()
  })

  // --- What makes it look again ---------------------------------------------

  new MutationObserver(evaluate).observe(root, { attributes: true, attributeFilter: ['data-call-docked', 'data-call-pane'] })
  window.addEventListener('resize', evaluate)
  if (bar) new ResizeObserver(() => { if (active) measure() }).observe(bar)
  chat.setAttribute('aria-expanded', String(chatOpen))
  renderBadge()

  return {
    setOnCall(on) {
      if (on === onCall) return
      onCall = on
      evaluate()
    },
    noteMessages(scope, ids, agentIds = []) {
      const before = unread.count
      const count = unread.update(scope, ids, !active || chatOpen, agentIds)
      if (count !== before) {
        renderBadge()
        if (count > before) announce.textContent = unreadAnnouncement(count)
      }
    },
  }
}
