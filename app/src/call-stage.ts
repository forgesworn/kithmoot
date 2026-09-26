import './call-layout.css'
import {
  ActiveSpeaker, StripOrder, CORNER_KEY, HIDE_NO_VIDEO_KEY, HIDE_SELF_KEY, VIEW_KEY,
  fitRect, initialsOf, layoutCall, loadPrefs, nearestCorner, nextCorner, savePref,
  type CallView, type LayoutPrefs, type LayoutResult, type Rect, type ShareInput,
} from './call-layout.js'

/**
 * The call stage on a desktop-sized window: measures the room, asks
 * `call-layout.ts` where everything goes, and writes the answer on.
 *
 * Nothing here creates, moves or removes a `<video>` or `<audio>`. They
 * belong to `render()` in main.ts and to the liveness rules beside it, which
 * treat a picture that has left its own device's holder as gone, and a
 * media element taken out of the document is paused by the browser. So the
 * tiles are placed where they already are: each person's tile is positioned
 * absolutely inside `#room`, and a shared screen, which lives in its owner's
 * tile, is positioned from there onto the stage.
 *
 * It runs on the room's size and on who is in it, never on a picture
 * decoding: that is the promise that stops a late frame moving everybody.
 * The one thing a decoded picture changes is the size of a share's own
 * element inside its fixed place on the stage, so that it carries no bands;
 * the picture itself is drawn in the same place either way.
 *
 * Phones keep their own layout (`#roomArea[data-mobile-view]` in
 * style.css): below `DESKTOP_STAGE` this takes its hands off entirely.
 */

/** Where this layout runs. Outside it, style.css's phone and short-window
 *  rules are untouched. */
export const DESKTOP_STAGE = '(min-width: 701px) and (min-height: 541px)'

/** A spoken "X is speaking" at most this often. */

interface Person {
  box: HTMLElement
  id: string
  name: string
  self: boolean
  cameras: HTMLVideoElement[]
  shares: HTMLVideoElement[]
  onCall: boolean
}

const LAYOUT_ATTR = 'data-call-layout'

export interface CallStage {
  /** Lays the room out again now. */
  refresh(): void
  dispose(): void
}

export function installCallStage(room: HTMLElement, host: HTMLElement, storage: Storage = localStorage): CallStage {
  const prefs: LayoutPrefs = loadPrefs(storage)
  const media = matchMedia(DESKTOP_STAGE)
  const speaker = new ActiveSpeaker()
  const stripOrder = new StripOrder()
  let view: CallView = prefs.view
  let knownShares = new Set<string>()
  let pinned: string | undefined
  let last: LayoutResult | undefined
  let dragging = false
  let queued = 0
  let recheck: ReturnType<typeof setTimeout> | undefined
  const styled = new Set<HTMLVideoElement>()

  const bar = buildToolbar()
  host.insertBefore(bar.root, room)

  const schedule = (): void => {
    if (queued) return
    queued = requestAnimationFrame(() => { queued = 0; apply() })
  }

  function people(): Person[] {
    const out: Person[] = []
    for (const [index, child] of [...room.children].entries()) {
      if (!(child instanceof HTMLElement) || !child.classList.contains('participant')) continue
      const name = child.dataset.name || child.querySelector('h3 .name')?.textContent || 'Somebody'
      out.push({
        box: child,
        id: child.dataset.participant ?? `tile-${index}`,
        name,
        self: child.dataset.self === 'true',
        cameras: [...child.querySelectorAll<HTMLVideoElement>(':scope > .media > video:not(.screenPreview)')],
        shares: [...child.querySelectorAll<HTMLVideoElement>(':scope > .media > video.screenPreview')],
        onCall: child.classList.contains('onCall'),
      })
    }
    return out
  }

  function apply(): void {
    const everyone = people()
    const anyPicture = everyone.some(person => person.cameras.length > 0 || person.shares.length > 0)
    const width = room.clientWidth
    const height = room.clientHeight
    if (!media.matches || !anyPicture || !room.isConnected) return clear(everyone)
    if (!room.hasAttribute('data-layout')) {
      // First pass: the room takes its height from the stylesheet only once
      // it is in this mode, so measure on the next frame.
      room.setAttribute('data-layout', 'gallery')
      schedule()
      return
    }
    if (width === 0 || height === 0) return
    // How far down the page the stage starts, for the height rule in
    // call-layout.css: a browser tab has no fixed height to divide, so the
    // stage takes what is left of the window below the call bar.
    const top = `${Math.max(0, Math.round(room.getBoundingClientRect().top + window.scrollY))}px`
    setStyle(room, '--call-stage-top', top)

    // Who gets a tile. Somebody in the room who is not on the call and
    // shows nothing is not in the call's picture.
    let shown = everyone.filter(person => person.onCall || person.cameras.length > 0 || person.shares.length > 0)
    if (prefs.hideSelf) shown = shown.filter(person => !person.self)
    if (prefs.hideNoVideo) shown = shown.filter(person => person.cameras.length > 0)
    const shares: (ShareInput & { video: HTMLVideoElement; owner: Person })[] = []
    for (const person of everyone) {
      for (const [i, video] of person.shares.entries()) {
        const aspect = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : undefined
        shares.push({ id: `${person.id}#${i}`, aspect, video, owner: person })
      }
    }
    if (shown.length === 0 && shares.length === 0) shown = everyone

    // A share starting puts it on the stage; the last one ending hands the
    // room back to whatever this device was using before.
    const shareIds = new Set(shares.map(share => share.id))
    if ([...shareIds].some(id => !knownShares.has(id))) view = 'share'
    if (shareIds.size === 0 && view === 'share') view = prefs.view
    knownShares = shareIds

    if (pinned !== undefined && !shown.some(person => person.id === pinned)) pinned = undefined
    const speaking = new Set(everyone.filter(person => person.box.classList.contains('speaking')).map(person => person.id))
    const candidates = shown.filter(person => !person.self).map(person => person.id)
    const now = performance.now()
    const active = speaker.update(speaking, candidates, now)
    const lead = stripOrder.update(speaking, pinned, now)
    if (recheck) { clearTimeout(recheck); recheck = undefined }
    const wait = Math.min(active.recheckIn ?? Infinity, lead.recheckIn ?? Infinity)
    if (wait !== Infinity) recheck = setTimeout(schedule, wait + 20)

    const self = shown.find(person => person.self)
    const out = layoutCall({
      width,
      height,
      view,
      people: shown.map(person => person.id),
      self: self?.id,
      shares,
      featured: pinned ?? active.current,
      selfCorner: prefs.corner,
      stripFirst: lead.first,
      scroll: { x: room.scrollLeft, y: room.scrollTop },
    })
    last = out
    room.setAttribute('data-layout', out.mode)

    for (const person of everyone) {
      const rect = out.people.get(person.id)
      const box = person.box
      if (!rect) {
        setAttr(box, 'data-layout-hidden', '')
        place(box, { x: 0, y: 0, width: 0, height: 0 })
      } else {
        box.removeAttribute('data-layout-hidden')
        if (!(dragging && out.floating === person.id)) place(box, rect)
      }
      setAttr(box, 'data-floating', out.floating === person.id ? '' : null)
      setAttr(box, 'data-featured', out.featured === person.id ? '' : null)
      setAttr(box, 'data-initials', initialsOf(person.name))
      setAttr(box, 'data-camera', person.cameras.length > 0 ? 'on' : 'off')
      ensurePin(person, out)
    }

    // Each share's element, onto its place: positioned from its owner's
    // tile, because that is where it lives.
    for (const share of shares) {
      const slot = out.shares.get(share.id)
      if (!slot) continue
      const origin = boxOrigin(share.owner.box)
      const picture = share.aspect ? fitRect(slot, share.aspect) : slot
      placeVideo(share.video, { x: picture.x - origin.x, y: picture.y - origin.y, width: picture.width, height: picture.height })
      const expand = share.owner.box.querySelectorAll<HTMLElement>(':scope > .shareExpand')[share.owner.shares.indexOf(share.video)]
      if (expand) placeExpand(expand, slot, picture, origin)
    }

    renderToolbar(everyone, shares.length, out)

    // A picture that was a share and is not any more keeps no pixels from
    // the stage: inline sizes outlive the share they were measured for.
    const current = new Set(shares.map(share => share.video))
    for (const video of styled) if (!current.has(video)) { unplaceVideo(video); styled.delete(video) }
    for (const video of current) styled.add(video)
  }

  /** Hands the room back to style.css. */
  function clear(everyone: Person[]): void {
    if (!room.hasAttribute('data-layout')) { bar.root.hidden = true; return }
    room.removeAttribute('data-layout')
    room.style.removeProperty('--call-stage-top')
    bar.root.hidden = true
    last = undefined
    for (const video of styled) unplaceVideo(video)
    styled.clear()
    for (const person of everyone) {
      for (const name of ['left', 'top', 'width', 'height', '--tile-w', '--tile-h']) person.box.style.removeProperty(name)
      for (const attr of ['data-layout-hidden', 'data-floating', 'data-featured', 'data-initials', 'data-camera']) person.box.removeAttribute(attr)
      for (const expand of person.box.querySelectorAll<HTMLElement>(':scope > .shareExpand')) {
        expand.style.removeProperty('left'); expand.style.removeProperty('top'); expand.removeAttribute('data-on-stage')
      }
      person.box.querySelector(`:scope > [${LAYOUT_ATTR}]`)?.remove()
    }
  }

  function boxOrigin(box: HTMLElement): { x: number; y: number } {
    return { x: parseFloat(box.style.left) || 0, y: parseFloat(box.style.top) || 0 }
  }

  function place(box: HTMLElement, rect: Rect): void {
    setStyle(box, 'left', `${rect.x}px`)
    setStyle(box, 'top', `${rect.y}px`)
    setStyle(box, 'width', `${rect.width}px`)
    setStyle(box, 'height', `${rect.height}px`)
    setStyle(box, '--tile-w', `${rect.width}px`)
    setStyle(box, '--tile-h', `${rect.height}px`)
  }

  function placeVideo(video: HTMLVideoElement, rect: Rect): void {
    setStyle(video, 'left', `${rect.x}px`)
    setStyle(video, 'top', `${rect.y}px`)
    setStyle(video, 'width', `${rect.width}px`)
    setStyle(video, 'height', `${rect.height}px`)
  }

  /**
   * The button that opens a share full size, next to the picture rather
   * than on it: beside its top right corner when the stage has room there,
   * above it when it has room there, and only on the picture when neither.
   */
  function placeExpand(expand: HTMLElement, slot: Rect, picture: Rect, origin: { x: number; y: number }): void {
    const width = expand.offsetWidth || 180
    const height = expand.offsetHeight || 30
    const right = picture.x + picture.width
    let place: { x: number; y: number; where: string }
    if (slot.x + slot.width - right >= width + 8) place = { x: right + 8, y: picture.y, where: 'beside' }
    else if (picture.y - slot.y >= height + 8) place = { x: right - width, y: picture.y - height - 6, where: 'above' }
    else place = { x: right - width - 8, y: picture.y + 8, where: 'over' }
    setStyle(expand, 'left', `${place.x - origin.x}px`)
    setStyle(expand, 'top', `${place.y - origin.y}px`)
    setAttr(expand, 'data-on-stage', place.where)
  }

  function unplaceVideo(video: HTMLVideoElement): void {
    for (const name of ['left', 'top', 'width', 'height']) video.style.removeProperty(name)
  }

  /** A way to spotlight somebody. Survives `render()` because main.ts keeps
   *  any child marked with `data-call-layout`. */
  function ensurePin(person: Person, out: LayoutResult): void {
    let pin = person.box.querySelector<HTMLButtonElement>(`:scope > button.tilePin[${LAYOUT_ATTR}]`)
    const wanted = !person.self && out.mode !== 'solo' && out.people.has(person.id)
    if (!wanted) { pin?.remove(); return }
    if (!pin) {
      pin = document.createElement('button')
      pin.type = 'button'
      pin.className = 'tilePin'
      pin.setAttribute(LAYOUT_ATTR, '')
      pin.addEventListener('click', () => {
        const id = pin!.closest<HTMLElement>('.participant')?.dataset.participant
        if (id === undefined) return
        pinned = pinned === id ? undefined : id
        // A pin is a request to see this person big: Speaker view is where
        // that happens. Unpinning leaves the view where it is.
        if (pinned !== undefined && view === 'gallery') view = 'speaker'
        apply()
      })
      person.box.append(pin)
    }
    const on = pinned === person.id
    setText(pin, on ? 'Unpin' : 'Pin')
    setAttr(pin, 'aria-pressed', String(on))
    setAttr(pin, 'aria-label', `${on ? 'Unpin' : 'Pin'} ${person.name}`)
  }

  // --- The control in the call bar ------------------------------------------

  function buildToolbar() {
    const root = document.createElement('div')
    root.id = 'callView'
    root.className = 'callView'
    root.hidden = true

    const views = document.createElement('div')
    views.className = 'callViewChoice'
    views.setAttribute('role', 'group')
    views.setAttribute('aria-label', 'Call layout')
    const buttons = new Map<CallView, HTMLButtonElement>()
    for (const [value, label] of [['gallery', 'Gallery'], ['speaker', 'Speaker'], ['share', 'Screen']] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.dataset.view = value
      button.addEventListener('click', () => choose(value))
      buttons.set(value, button)
      views.append(button)
    }

    const speakingLine = document.createElement('p')
    speakingLine.id = 'speakingNow'
    speakingLine.className = 'speakingNow'

    const move = document.createElement('button')
    move.type = 'button'
    move.id = 'moveSelfView'
    move.className = 'quiet'
    move.hidden = true
    move.addEventListener('click', () => {
      prefs.corner = nextCorner(prefs.corner)
      savePref(storage, CORNER_KEY, prefs.corner)
      apply()
      move.setAttribute('aria-label', `Move my picture. Now ${prefs.corner.replace('-', ' ')}.`)
    })
    move.textContent = 'Move my picture'

    const options = document.createElement('details')
    options.className = 'callViewOptions'
    const summary = document.createElement('summary')
    summary.textContent = 'View options'
    options.append(summary)
    const panel = document.createElement('div')
    panel.className = 'callViewPanel'
    options.append(panel)
    const toggle = (key: string, label: string, get: () => boolean, set: (value: boolean) => void): HTMLInputElement => {
      const row = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = get()
      input.addEventListener('change', () => { set(input.checked); savePref(storage, key, input.checked); apply() })
      row.append(input, ` ${label}`)
      panel.append(row)
      return input
    }
    toggle(HIDE_SELF_KEY, 'Hide my own picture', () => prefs.hideSelf, value => { prefs.hideSelf = value })
    toggle(HIDE_NO_VIDEO_KEY, 'Hide people without video', () => prefs.hideNoVideo, value => { prefs.hideNoVideo = value })

    root.append(views, speakingLine, move, options)
    return { root, buttons, speakingLine, move }
  }

  function choose(value: CallView): void {
    view = value
    if (value !== 'share') {
      prefs.view = value
      savePref(storage, VIEW_KEY, value)
    }
    apply()
  }

  function renderToolbar(everyone: Person[], shareCount: number, out: LayoutResult): void {
    bar.root.hidden = false
    const current: CallView = out.mode === 'solo' ? view : out.mode
    for (const [value, button] of bar.buttons) {
      setAttr(button, 'aria-pressed', String(value === current))
      button.disabled = value === 'share' && shareCount === 0
    }
    // This device's own person never appears on the line - their tile keeps
    // its speaking ring, but seeing your own name here while you talk is
    // pointless. When you are the only one speaking, this reads exactly as
    // when nobody is.
    const talking = everyone.filter(person => !person.self && person.box.classList.contains('speaking')).map(person => person.name)
    setText(bar.speakingLine, talking.length ? `Speaking: ${talking.join(', ')}` : 'Nobody is speaking')
    setAttr(bar.speakingLine, 'data-quiet', talking.length ? null : '')
    bar.move.hidden = out.mode !== 'solo'
  }

  // --- Dragging your own picture in a call of two ---------------------------

  const onPointerDown = (event: PointerEvent): void => {
    const box = (event.target as Element | null)?.closest<HTMLElement>('.participant[data-floating]')
    if (!box || (event.target as Element).closest('button, a, input')) return
    if (event.button !== 0) return
    const start = { x: event.clientX, y: event.clientY, left: parseFloat(box.style.left) || 0, top: parseFloat(box.style.top) || 0 }
    dragging = true
    box.setPointerCapture(event.pointerId)
    box.setAttribute('data-dragging', '')
    const move = (e: PointerEvent): void => {
      const maxX = room.clientWidth - box.offsetWidth
      const maxY = room.scrollHeight - box.offsetHeight
      box.style.left = `${Math.max(0, Math.min(maxX, start.left + e.clientX - start.x))}px`
      box.style.top = `${Math.max(0, Math.min(maxY, start.top + e.clientY - start.y))}px`
    }
    const up = (): void => {
      box.removeEventListener('pointermove', move)
      box.removeEventListener('pointerup', up)
      box.removeEventListener('pointercancel', up)
      box.removeAttribute('data-dragging')
      dragging = false
      const main = last?.featured !== undefined ? last.people.get(last.featured) : undefined
      if (main) {
        const centreX = (parseFloat(box.style.left) || 0) + box.offsetWidth / 2
        const centreY = (parseFloat(box.style.top) || 0) + box.offsetHeight / 2
        prefs.corner = nearestCorner(main, centreX, centreY)
        savePref(storage, CORNER_KEY, prefs.corner)
      }
      apply()
    }
    box.addEventListener('pointermove', move)
    box.addEventListener('pointerup', up)
    box.addEventListener('pointercancel', up)
    event.preventDefault()
  }
  room.addEventListener('pointerdown', onPointerDown)

  // --- What makes it run again ---------------------------------------------

  // Children and classes only: `render()` rebuilding a tile, a picture
  // arriving or leaving, a share starting, somebody starting to speak. Not
  // style, which is what this writes.
  const mutations = new MutationObserver(schedule)
  mutations.observe(room, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  const sizes = new ResizeObserver(schedule)
  sizes.observe(room)
  media.addEventListener('change', schedule)
  // A strip longer than the room scrolls, and the stage follows the scroll
  // in the same frame so it never slides out of view.
  const onScroll = (): void => { if (room.hasAttribute('data-layout')) apply() }
  room.addEventListener('scroll', onScroll, { passive: true })
  schedule()

  return {
    refresh: apply,
    dispose() {
      mutations.disconnect()
      sizes.disconnect()
      media.removeEventListener('change', schedule)
      room.removeEventListener('scroll', onScroll)
      room.removeEventListener('pointerdown', onPointerDown)
      if (queued) cancelAnimationFrame(queued)
      if (recheck) clearTimeout(recheck)
      clear(people())
      bar.root.remove()
    },
  }
}

// Writes that do nothing when nothing changed, so a pass that changes
// nothing cannot wake anything up.
function setStyle(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value)
}
function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) { if (el.hasAttribute(name)) el.removeAttribute(name); return }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}
function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text
}
