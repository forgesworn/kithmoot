import './call-focus.css'
import {
  UnreadCounter, callFirst, chatPanelOpen, clearChatDividerFraction, loadChatDividerFraction, loadChatPanel,
  saveChatDividerFraction, saveChatPanel, toolbarMove, unreadAnnouncement,
} from './call-focus-model.js'
import {
  CALL_PANE_FLOOR_PX, CHAT_DIVIDER_DEFAULT_FRACTION, CHAT_DIVIDER_STEP_FRACTION, CHAT_DIVIDER_STEP_FRACTION_LARGE,
  CHAT_MIN_WIDTH_PX, chatDividerFraction, chatDividerWidth,
} from './desktop-panes.js'

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
  const stage = document.getElementById('callStage')!
  const controls = document.getElementById('deviceControls')!
  const bar = document.querySelector<HTMLElement>('#roomArea > .roomBar')
  const extras = document.getElementById('callExtras') as HTMLDetailsElement | null

  let onCall = false
  let active = false
  let remembered = loadChatPanel(storage)
  let chatOpen = chatPanelOpen(remembered, window.innerWidth)
  const unread = new UnreadCounter()
  let moved: Moved[] = []
  // What this device has dragged the divider to, or undefined while it is
  // still the CSS default (`--call-chat-w`'s own `clamp()`) that nobody has
  // touched. Set once, from here on every resize reapplies it as a width -
  // see `reflowDivider` - so the split stays the same fraction of the room
  // rather than the same number of pixels.
  let dividerFraction = loadChatDividerFraction(storage)
  let dragState: { pointerId: number; startX: number; lastX: number; startWidth: number; containerWidth: number } | null = null
  let dividerFrame = 0

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

  // The divider between the stage and the conversation. One element serves
  // both layouts this file draws (see call-focus.css): it never joins the
  // flex row or the absolutely-positioned column itself, it just sits in the
  // gap between them and is placed there by measurement, in `measureDivider`
  // below, rather than by its own CSS - the gap is a fixed width in one
  // layout and a flexible one in the other, and measuring what actually
  // rendered is simpler than describing both.
  const divider = document.createElement('div')
  divider.id = 'callChatDivider'
  divider.className = 'callChatDivider'
  divider.setAttribute('role', 'separator')
  divider.setAttribute('aria-orientation', 'vertical')
  divider.setAttribute('aria-label', 'Resize chat')
  divider.tabIndex = 0
  divider.hidden = true

  controls.prepend(status)
  if (extras?.parentElement === controls) extras.before(viewMenu)
  else controls.append(viewMenu)
  controls.append(end, announce)
  room.append(divider)

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
      reflowDivider()
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
    cancelDrag()
    divider.hidden = true
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
    reflowDivider()
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

  // --- The divider between the call and the conversation -----------------------

  /** The row the divider divides: `.desktopRoomContent` in the installed
   *  window, `#roomArea` itself otherwise - the same element either layout
   *  measures the chat panel's share against. */
  function container(): HTMLElement {
    return (stage.parentElement as HTMLElement | null) ?? room
  }

  /** The chat panel's width as it stands: what a dragged fraction says, or -
   *  before this device has ever dragged it - what actually rendered, so the
   *  divider's first move is a continuation of where it visibly is rather
   *  than a jump to some other number. */
  function currentWidth(): number {
    const width = container().getBoundingClientRect().width
    if (dividerFraction !== undefined) return chatDividerWidth(width, dividerFraction)
    return Math.max(0, container().getBoundingClientRect().right - stage.getBoundingClientRect().right)
  }

  /** Sets the split to `fraction`, clamped, and applies it as a width so it
   *  takes hold in both layouts this file draws - see `--call-chat-w` in
   *  call-focus.css. */
  function applyFraction(fraction: number): void {
    const width = container().getBoundingClientRect().width
    dividerFraction = chatDividerFraction(width, chatDividerWidth(width, fraction))
    root.style.setProperty('--call-chat-w', `${chatDividerWidth(width, dividerFraction)}px`)
    renderDividerA11y()
    measureDivider()
  }

  /** Back to the default split, forgetting anything this device dragged. */
  function resetDivider(): void {
    dividerFraction = CHAT_DIVIDER_DEFAULT_FRACTION
    clearChatDividerFraction(storage)
    const width = container().getBoundingClientRect().width
    root.style.setProperty('--call-chat-w', `${chatDividerWidth(width, dividerFraction)}px`)
    renderDividerA11y()
    measureDivider()
  }

  /** Reapplies the dragged fraction as a width after a resize, so the split
   *  stays the same share of the room rather than the same number of pixels.
   *  Nothing to reapply while nobody has ever dragged it: the CSS default is
   *  already responsive on its own. */
  function reflowDivider(): void {
    if (!active || !chatOpen) { divider.hidden = true; return }
    divider.hidden = false
    if (dividerFraction !== undefined) {
      const width = container().getBoundingClientRect().width
      root.style.setProperty('--call-chat-w', `${chatDividerWidth(width, dividerFraction)}px`)
    }
    renderDividerA11y()
    measureDivider()
  }

  /** Where the divider sits: in the gap between the stage's rendered right
   *  edge and the conversation's, measured rather than placed by its own
   *  CSS - see the element's own comment for why. */
  function measureDivider(): void {
    if (divider.hidden) return
    const stageRect = stage.getBoundingClientRect()
    const roomRect = room.getBoundingClientRect()
    divider.style.left = `${Math.round(stageRect.right - roomRect.left)}px`
    divider.style.top = `${Math.round(stageRect.top - roomRect.top)}px`
    divider.style.height = `${Math.round(stageRect.height)}px`
  }

  function renderDividerA11y(): void {
    const width = container().getBoundingClientRect().width
    const now = currentWidth()
    const min = chatDividerWidth(width, chatDividerFraction(width, CHAT_MIN_WIDTH_PX))
    const max = chatDividerWidth(width, chatDividerFraction(width, width - CALL_PANE_FLOOR_PX))
    const pct = (value: number): number => width <= 0 ? 0 : Math.round((value / width) * 100)
    divider.setAttribute('aria-valuemin', String(pct(min)))
    divider.setAttribute('aria-valuemax', String(pct(max)))
    divider.setAttribute('aria-valuenow', String(pct(now)))
    divider.setAttribute('aria-valuetext', `Chat ${pct(now)}% of the room`)
  }

  function cancelDrag(): void {
    if (dividerFrame) { cancelAnimationFrame(dividerFrame); dividerFrame = 0 }
    if (dragState) {
      if (divider.hasPointerCapture(dragState.pointerId)) divider.releasePointerCapture(dragState.pointerId)
      dragState = null
    }
    delete divider.dataset.dragging
    root.removeAttribute('data-call-chat-dragging')
  }

  divider.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    dragState = { pointerId: event.pointerId, startX: event.clientX, lastX: event.clientX, startWidth: currentWidth(), containerWidth: container().getBoundingClientRect().width }
    divider.setPointerCapture(event.pointerId)
    divider.dataset.dragging = ''
    root.setAttribute('data-call-chat-dragging', '')
    // `preventDefault` below stops the drag selecting text, but it also
    // stops the pointer's own default focus - put it back by hand.
    divider.focus({ preventScroll: true })
    event.preventDefault()
  })
  divider.addEventListener('pointermove', event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    dragState.lastX = event.clientX
    if (dividerFrame) return
    dividerFrame = requestAnimationFrame(() => {
      dividerFrame = 0
      if (!dragState) return
      // The divider moving right hands width to the call pane on its left,
      // so a positive move is a smaller chat, not a bigger one.
      const widthPx = dragState.startWidth - (dragState.lastX - dragState.startX)
      applyFraction(chatDividerFraction(dragState.containerWidth, widthPx))
    })
  })
  const endDrag = (event: PointerEvent): void => {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    cancelDrag()
    if (dividerFraction !== undefined) saveChatDividerFraction(storage, dividerFraction)
  }
  divider.addEventListener('pointerup', endDrag)
  divider.addEventListener('pointercancel', endDrag)
  divider.addEventListener('dblclick', () => resetDivider())
  divider.addEventListener('keydown', event => {
    const width = container().getBoundingClientRect().width
    const step = event.shiftKey ? CHAT_DIVIDER_STEP_FRACTION_LARGE : CHAT_DIVIDER_STEP_FRACTION
    const now = chatDividerFraction(width, currentWidth())
    switch (event.key) {
      // Left moves the divider left, widening the chat on its right.
      case 'ArrowLeft': applyFraction(now + step); break
      case 'ArrowRight': applyFraction(now - step); break
      case 'Home': applyFraction(chatDividerFraction(width, CHAT_MIN_WIDTH_PX)); break
      case 'End': applyFraction(chatDividerFraction(width, width - CALL_PANE_FLOOR_PX)); break
      case 'Enter': resetDivider(); return event.preventDefault()
      default: return
    }
    event.preventDefault()
    if (dividerFraction !== undefined) saveChatDividerFraction(storage, dividerFraction)
  })
  // Nothing to apply straight away: the room has no size worth measuring
  // until a call actually puts the layout into its row shape, and
  // `reflowDivider` (from `evaluate`, above) does that the moment it does.
  new ResizeObserver(() => { if (active) reflowDivider() }).observe(room)

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
