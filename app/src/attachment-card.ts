import type { AttachmentDecision } from '../../src/attachment-safety.js'
import { createAttachmentPreview, destroyAttachmentPreviews } from './attachment-preview.js'
import { icon } from './icons.js'

/**
 * The attachment card: what a file under a message looks like at each step,
 * from a closed card to an opened, warned or blocked one. Drawing only. The
 * fetch, the check against the hash, the decryption and the decision
 * (`assessAttachment`) belong to the caller, so a second way of fetching a
 * file reaches the same card.
 */

/** A file that has been fetched, decrypted and assessed. */
export interface OpenedFile {
  /** An object URL over the verified bytes, retained for the Save action. */
  url: string
  /** The verified bytes, re-wrapped as the type the bytes are. */
  blob: Blob
  /** The cleaned envelope name: the only name used once a file is open. */
  name: string
  type: string
  size: number
  text?: string
  expanded?: boolean
  /** The Save… question is showing. */
  confirming?: boolean
  decision: AttachmentDecision
}

export type OpenedAttachment = OpenedFile | { error: string }

export interface CardView {
  /** Unique in the page, for element ids. */
  id: string
  index: number
  /** The message's name for the file, cleaned of invisibles. */
  closedName: string
  /** "Image · 512 KB": the family and the download size. */
  closedMeta: string
  opened?: OpenedAttachment
  /** The desktop app cannot open a blob: window, so a PDF is Save only there. */
  desktop: boolean
  /** Native desktop opens image, audio and video through its own viewer. */
  nativeMedia?: boolean
  formatBytes(n: number): string
  show(button: HTMLButtonElement): void
  /** Draw the card again after a change of state the card owns. */
  redraw(focus?: 'first' | 'save'): void
  openViewer(file: OpenedFile, trigger: HTMLElement): void
  copyText(text: string): Promise<boolean>
}

const PREVIEW_LINES = 9
const PREVIEW_CHARS = 600

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A control: its words are what is seen, its name is the words plus the file's name. */
function named(control: HTMLElement, words: string, name: string): void {
  control.append(words)
  const rest = el('span', 'sr-only', ` ${name}`)
  control.append(rest)
}

function button(words: string, name: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'actBtn')
  b.type = 'button'
  named(b, words, name)
  b.addEventListener('click', onClick)
  return b
}

/** The first words of the opening error the person can act on. */
export function openingErrorText(err: unknown, host: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/not the file the message named/i.test(message)) return 'This isn’t the file that was sent, so KithMoot didn’t open it.'
  // 410 is a server saying the file is gone for good, as a store that has
  // closed answers; to the person it is the same as 404.
  if (/answered (?:404|410)/i.test(message)) return `This file is no longer on ${host}.`
  if (/recovery key is wrong|envelope was modified|padding is invalid|not a (?:Wildbloom|valid)/i.test(message)) return 'This file is damaged or was changed, so it couldn’t be opened.'
  if (/larger than this room will fetch|too large/i.test(message)) return 'This file is too large to open here.'
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed|abort|timeout/i.test(message)) return `Couldn’t reach ${host}. Try again.`
  return message
}

function previewText(opened: OpenedFile): string {
  const text = opened.text ?? ''
  if (opened.expanded) return text
  const lines = text.split('\n')
  let shown = lines.slice(0, PREVIEW_LINES).join('\n')
  if (shown.length > PREVIEW_CHARS) shown = shown.slice(0, PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/, '')
  return shown.length < text.length ? `${shown}…` : shown
}

function sayBox(kind: 'warn' | 'block', message: string, id: string): HTMLElement {
  const box = el('div', `say ${kind}`)
  box.append(icon('warn'))
  const p = el('p')
  p.id = id
  p.textContent = message
  box.append(p)
  return box
}

/** Paint a card from its view. Replaces whatever the card held. */
export function paintAttachmentCard(card: HTMLElement, v: CardView): void {
  if (v.opened && 'url' in v.opened) destroyAttachmentPreviews(v.opened.url)
  card.replaceChildren()
  card.classList.remove('hasMedia')
  const opened = v.opened
  const key = `attachment-${v.index}`
  const body = el('div', 'attBody')
  card.append(body)

  const row = (name: string, meta: string): HTMLElement => {
    const ico = icon('file')
    ico.classList.add('attIcon')
    const label = el('div', 'attLabel')
    const n = el('bdi', 'attName', name)
    const m = el('span', 'attMeta', meta)
    label.append(n, m)
    body.append(ico, label)
    const actions = el('div', 'attActions')
    body.append(actions)
    return actions
  }

  if (!opened || 'error' in opened) {
    const actions = row(v.closedName, v.closedMeta)
    const show = el('button', 'actBtn')
    show.type = 'button'
    named(show, opened ? 'Try again' : 'Show', v.closedName)
    show.dataset.focusKey = key
    show.addEventListener('click', () => v.show(show))
    actions.append(show)
    if (opened && 'error' in opened) {
      const why = el('p', 'attWhy', opened.error)
      body.append(why)
    }
    return
  }

  const d = opened.decision
  const name = opened.name
  const meta = `${d.family} · ${v.formatBytes(opened.size)}`

  // Untrusted media is decoded only inside its opaque-origin frame. Native
  // desktop uses an Open action instead of creating a web media frame.
  if (!v.nativeMedia && d.preview === 'image') {
    const preview = createAttachmentPreview(opened, 'image')
    const expand = el('button', 'attachmentImageExpand')
    expand.type = 'button'
    expand.setAttribute('aria-label', `Expand ${name}`)
    expand.dataset.focusKey = key
    expand.onclick = () => v.openViewer(opened, expand)
    const surface = el('div', 'attachmentImage')
    surface.append(preview.element, expand)
    const frame = el('div', 'attPreview')
    frame.append(surface)
    body.append(frame)
    card.classList.add('hasMedia')
  } else if (!v.nativeMedia && (d.preview === 'video' || d.preview === 'audio')) {
    const preview = createAttachmentPreview(opened, d.preview)
    preview.element.dataset.focusKey = key
    const frame = el('div', 'attPreview')
    frame.append(preview.element)
    body.append(frame)
    card.classList.add('hasMedia')
  }

  const actions = row(name, meta)
  const first = (node: HTMLElement): void => { if (!node.dataset.focusKey) node.dataset.focusKey = key }

  const textPreview = d.preview === 'text' && opened.text !== undefined
  const save = (words: string): HTMLAnchorElement => {
    const a = el('a', 'actBtn')
    a.href = opened.url
    a.download = name
    named(a, words, name)
    return a
  }

  const nativeMedia = v.nativeMedia && (d.preview === 'image' || d.preview === 'video' || d.preview === 'audio')
  if (nativeMedia || (d.preview === 'pdf' && !v.desktop)) {
    const open = button('Open', name, () => v.openViewer(opened, open))
    first(open)
    actions.append(open)
  }

  if (d.save === 'quiet') {
    const s = save('Save')
    first(s)
    actions.append(s)
  } else if (d.save === 'warn') {
    const warnId = `${v.id}-say`
    if (opened.confirming) {
      const cancel = el('button', 'actBtn', 'Cancel')
      cancel.type = 'button'
      cancel.setAttribute('aria-label', `Cancel saving ${name}`)
      const go = save('Save anyway')
      go.addEventListener('click', () => {
        // After the download has started, not before: removing the anchor in
        // its own click would drop the download.
        setTimeout(() => { opened.confirming = false; v.redraw('save') }, 0)
      })
      const confirmGroup = el('div', 'attConfirm')
      confirmGroup.append(cancel, go)
      const q = el('div', 'say warn')
      q.setAttribute('role', 'group')
      q.append(icon('warn'))
      const p = el('p')
      p.id = warnId
      p.tabIndex = -1
      p.dataset.focusKey = key
      p.dataset.question = 'true'
      const strong = el('strong', undefined, `Save ${name}?`)
      p.append(strong, ` ${d.confirmation ?? d.message ?? ''}`)
      q.append(p)
      q.setAttribute('aria-labelledby', warnId)
      body.append(q, confirmGroup)
      cancel.addEventListener('click', () => { opened.confirming = false; v.redraw('save') })
      body.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        opened.confirming = false
        v.redraw('save')
      })
    } else {
      const s = el('button', 'actBtn')
      s.type = 'button'
      s.append('Save…')
      s.setAttribute('aria-label', `Save ${name}…`)
      s.dataset.saveWarned = 'true'
      first(s)
      s.addEventListener('click', () => { opened.confirming = true; v.redraw('first') })
      actions.append(s)
    }
  }
  // 'block' draws no Save at all.

  if (textPreview) {
    const pre = el('pre', 'attachmentText')
    pre.textContent = previewText(opened)
    pre.classList.toggle('collapsed', !opened.expanded)
    pre.tabIndex = 0
    pre.setAttribute('role', 'region')
    pre.setAttribute('aria-label', `Preview of ${name}`)
    body.append(pre)
    const tools = el('div', 'attTools')
    if ((opened.text ?? '').length > PREVIEW_CHARS || (opened.text ?? '').split('\n').length > PREVIEW_LINES) {
      const more = el('button', 'actBtn', opened.expanded ? 'Show less' : 'Read more')
      more.type = 'button'
      more.setAttribute('aria-expanded', String(!!opened.expanded))
      more.dataset.focusKey = `${key}-more`
      more.onclick = () => { opened.expanded = !opened.expanded; v.redraw() }
      tools.append(more)
    }
    const copy = el('button', 'actBtn', 'Copy text')
    copy.type = 'button'
    copy.onclick = async () => { copy.textContent = await v.copyText(opened.text!) ? 'Copied' : 'Copy failed' }
    tools.append(copy)
    body.append(tools)
  }

  if (d.save === 'block' && d.message) {
    const box = sayBox('block', d.message, `${v.id}-say`)
    const p = box.querySelector('p')!
    p.tabIndex = -1
    p.dataset.focusKey = key
    p.dataset.question = 'true'
    body.append(box)
  } else if (d.save === 'warn' && !opened.confirming && d.message) {
    const box = sayBox('warn', d.message, `${v.id}-say`)
    body.append(box)
    const saveWarned = actions.querySelector<HTMLElement>('[data-save-warned]')
    saveWarned?.setAttribute('aria-describedby', `${v.id}-say`)
  }
}
