import { menuGroups, menuItem, menuSubmenu, wireMenu, type MenuHandle } from './menu.js'

/**
 * More, in the call bar (design-calm-shell 5.5, 10 and 11).
 *
 * A menu of what a call needs now and then, built from `app/src/menu.ts` like
 * the room's own ⋯: a popover beside the bar, a sheet from the bottom edge on
 * a phone. It is rebuilt every time it opens, so an item is there only when
 * it applies and a switch always says what it is.
 *
 * It works by DOM, not by a second copy of anything. Every switch clicks the
 * button that has always done that job (`#toggleCompanion`, `#toggleMirror`,
 * `#toggleAgentsHear`, `#recordToggle`, the view buttons in `#callView`), so
 * its handler, its storage and its specs are the ones they were. Those
 * buttons stay where they are in the page, out of sight, in
 * `#callExtrasContent`. Nothing here creates, moves or removes a `<video>` or
 * an `<audio>`: Effects and the meeting controls are shown where they stand,
 * as panels, because `#effects` holds an `<audio>` and an element taken out of
 * the document is paused.
 */

export interface CallMoreHooks {
  /** Invite people…, when this room can: the invite dialog, opened. */
  invitePeople(): (() => void) | undefined
  /** This call goes through the relay only: its IP address is hidden. */
  ipHidden(): boolean
}

const COMPACT = '(max-width: 599px)'

const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null
const isOn = (el: HTMLElement | null): boolean => el?.getAttribute('aria-pressed') === 'true' || el?.dataset.on === 'true'
const shown = (el: HTMLElement | null): el is HTMLElement => !!el && !el.hidden

export interface CallMore {
  menu: MenuHandle
  /** Open the Effects panel, as the Effects… item does. */
  openEffects(): void
  /** Open the meeting panel, as Run as a meeting… does. */
  openMeeting(): void
  closePanels(): void
}

export function installCallMore(hooks: CallMoreHooks): CallMore {
  const opener = byId('callExtras')!
  const menuEl = byId('callMoreMenu')!
  const content = byId('callExtrasContent')!

  // --- Panels: the parts of the call that do not fit a menu row -----------

  interface Panel { el: HTMLElement; title: string }
  const panels: Panel[] = [
    { el: byId('effects')!, title: 'Effects' },
    { el: byId('meetingPanel')!, title: 'Run as a meeting' },
  ]
  let openPanel: Panel | undefined

  for (const panel of panels) {
    const { el, title } = panel
    el.classList.add('callPanel')
    // In the top layer, so it is over the call whatever stacking the call's
    // own parts make, and nothing is moved to get it there.
    el.popover = 'manual'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'false')
    const heading = document.createElement('h2')
    heading.className = 'callPanelHeading'
    heading.tabIndex = -1
    heading.id = `${el.id}Heading`
    heading.textContent = title
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'callPanelClose'
    close.textContent = 'Close'
    close.setAttribute('aria-label', `Close ${title}`)
    const bar = document.createElement('div')
    bar.className = 'callPanelBar'
    bar.append(heading, close)
    // A `<details>` keeps its summary first; the bar goes in front of that.
    el.prepend(bar)
    el.setAttribute('aria-labelledby', heading.id)
    close.addEventListener('click', () => closePanels(true))
    el.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      closePanels(true)
    })
  }

  function showPanel(panel: Panel): void {
    closePanels(false)
    openPanel = panel
    panel.el.dataset.panel = 'open'
    panel.el.showPopover()
    // Every section open: the panel is the place to read them.
    for (const section of panel.el.querySelectorAll<HTMLDetailsElement>(':scope details')) section.open = true
    if (panel.el instanceof HTMLDetailsElement) panel.el.open = true
    panel.el.querySelector<HTMLElement>('.callPanelHeading')!.focus()
  }

  function closePanels(restoreFocus = false): void {
    if (!openPanel) return
    try { openPanel.el.hidePopover() } catch { /* Already closed. */ }
    delete openPanel.el.dataset.panel
    openPanel = undefined
    if (restoreFocus && opener.isConnected) opener.focus({ preventScroll: true })
  }

  // A panel left open while its call ends, or its controls are taken away,
  // must not stay on screen.
  new MutationObserver(() => {
    if (openPanel && (openPanel.el.hidden || byId('deviceControls')?.hidden)) closePanels(false)
  }).observe(content, { attributes: true, subtree: true, attributeFilter: ['hidden'] })
  new MutationObserver(() => { if (byId('deviceControls')?.hidden) closePanels(false) })
    .observe(byId('deviceControls')!, { attributes: true, attributeFilter: ['hidden'] })

  // --- The menu -------------------------------------------------------------

  /** An item that clicks an existing button. */
  const click = (id: string): (() => void) => () => byId(id)?.click()

  /** A note the menu says and nobody can choose: dimmed, skipped by arrows. */
  const note = (menu: HTMLElement, text: string): void => {
    const item = menuItem(menu, text, () => {})
    item.disabled = true
    item.classList.add('menuNote')
  }

  function layout(menu: HTMLElement): void {
    const view = byId('callView')
    const choices = view && !view.hidden ? [...view.querySelectorAll<HTMLButtonElement>('.callViewChoice button')] : []
    const collapse = byId('callGalleryCollapse')
    const gallery = shown(byId('callSurfaceHeader')) && collapse
    if (choices.length === 0 && !gallery) return
    menuSubmenu(menu, 'Layout', sub => {
      for (const choice of choices) {
        const item = menuItem(sub, choice.textContent ?? '', () => choice.click(), { checked: choice.getAttribute('aria-pressed') === 'true', action: `layout-${choice.dataset.view}` })
        if (choice.disabled) item.disabled = true
      }
      const move = byId('moveSelfView')
      if (view && !view.hidden && shown(move)) menuItem(sub, 'Move my picture', () => move.click(), { action: 'layout-move' })
      for (const box of view?.querySelectorAll<HTMLInputElement>('.callViewPanel input[type="checkbox"]') ?? []) {
        menuItem(sub, box.parentElement?.textContent?.trim() ?? '', () => box.click(), { checked: box.checked, toggle: true, action: 'layout-option' })
      }
      if (gallery) {
        const hiding = collapse.getAttribute('aria-expanded') === 'true'
        menuItem(sub, hiding ? 'Hide the gallery' : 'Show the gallery', () => collapse.click(), { action: 'layout-gallery' })
      }
    }, { icon: 'board', id: 'callMoreLayout' })
  }

  function build(): void {
    const compact = window.matchMedia(COMPACT).matches
    const record = byId<HTMLButtonElement>('recordToggle')
    const meeting = byId('meetingPanel')
    const floating = byId('toggleFloatingMarks')
    const extras = [...(byId('shareExtras')?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(b => !b.hidden && !b.disabled)
    const invite = hooks.invitePeople()
    const wake = byId('wakeLockNote')
    const groups: Array<(menu: HTMLElement) => void> = [
      menu => {
        // The bar carries Share on a screen wide enough; a phone's menu does.
        const share = byId('toggleScreen')
        if (compact && share) menuItem(menu, isOn(share) ? 'Stop sharing' : 'Share screen', () => share.click(), { checked: isOn(share), toggle: true, icon: 'screen', action: 'share' })
        menuItem(menu, 'Effects…', () => showPanel(panels[0]), { icon: 'agent', id: 'callMoreEffects', action: 'effects' })
        layout(menu)
      },
      menu => {
        if (record && !record.hidden && !record.disabled) {
          menuItem(menu, isOn(record) ? 'Stop recording' : 'Record call…', () => record.click(), { icon: 'record', action: 'record' })
        }
        if (shown(meeting)) menuItem(menu, 'Run as a meeting…', () => showPanel(panels[1]), { icon: 'people', action: 'meeting' })
      },
      menu => {
        for (const [id, label, icon] of [['toggleCompanion', 'Use beside another device', 'devices'], ['toggleMirror', 'Mirror my view', 'video'], ['toggleAgentsHear', 'Let agents hear me', 'ear']] as const) {
          const button = byId(id)
          if (button) menuItem(menu, label, () => button.click(), { checked: isOn(button), toggle: true, icon, action: id })
        }
        if (shown(floating)) menuItem(menu, 'Show drawings in a floating window', () => floating.click(), { checked: isOn(floating), toggle: true, action: 'floating' })
        for (const button of extras) menuItem(menu, button.textContent?.trim() ?? '', () => button.click(), { action: `share-${button.id}` })
        if (!byId('mediaRecoveryNote')?.hidden) menuItem(menu, 'Resume call media', click('resumeCallMedia'), { action: 'resume' })
      },
      menu => {
        if (invite) menuItem(menu, 'Invite people…', invite, { icon: 'personAdd', action: 'invite' })
      },
      menu => {
        if (hooks.ipHidden()) note(menu, 'IP address hidden on this call')
        if (shown(wake)) note(menu, wake.textContent?.trim() ?? '')
      },
    ]
    menuGroups(menuEl, groups)
  }

  const menu = wireMenu(opener, menuEl, { beforeOpen: build, sheet: COMPACT })
  menuEl.setAttribute('aria-label', 'More call controls')

  return {
    menu,
    openEffects: () => showPanel(panels[0]),
    openMeeting: () => showPanel(panels[1]),
    closePanels: () => closePanels(false),
  }
}
