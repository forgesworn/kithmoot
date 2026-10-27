import { createAttachmentPreview, type AttachmentPreview, type AttachmentPreviewKind } from './attachment-preview.js'
import { setLocalImage } from './local-image.js'

function attachmentKind(blob: Blob): AttachmentPreviewKind {
  const mime = blob.type.split(';')[0]!.trim().toLowerCase()
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  throw new TypeError('This attachment has no sandboxed viewer.')
}

/** Trusted artwork keeps its direct image path. Blob-backed attachments are
 * isolated in an opaque-origin frame, including SVG and native PDF previews. */
export class AttachmentViewer {
  #dialog?: HTMLDialogElement
  #popup?: Window
  #preview?: AttachmentPreview
  #url?: string
  #returnFocus?: HTMLElement

  open(file: { url: string; displayUrl?: string; name: string; blob?: Blob }, trigger: HTMLElement): void {
    this.close()
    this.#url = file.url
    this.#returnFocus = trigger
    const dialog = document.createElement('dialog')
    dialog.className = 'attachmentViewer'
    dialog.setAttribute('aria-label', file.name)
    const header = document.createElement('header')
    const title = document.createElement('strong')
    title.textContent = file.name
    const surface = document.createElement('div')
    surface.className = 'attachmentViewerSurface'

    const blob = file.blob
    const untrusted = blob !== undefined
    const kind = untrusted ? attachmentKind(blob) : undefined
    let preview: AttachmentPreview | undefined
    if (untrusted) {
      preview = createAttachmentPreview({ blob, name: file.name }, kind!)
      this.#preview = preview
      surface.classList.add('sandboxed')
      surface.append(preview.element)
    } else {
      const img = setLocalImage(document.createElement('img'), { fallbackUrl: file.url, displayUrl: file.displayUrl })
      img.alt = file.name
      surface.append(img)
    }

    const size = document.createElement('button')
    size.type = 'button'
    size.textContent = 'Actual size'
    size.setAttribute('aria-pressed', 'false')
    size.onclick = () => {
      const actual = surface.classList.toggle('actualSize')
      preview?.setActualSize(actual)
      size.textContent = actual ? 'Fit to window' : 'Actual size'
      size.setAttribute('aria-pressed', String(actual))
    }

    let pop: HTMLButtonElement | undefined
    if (!untrusted) {
      pop = document.createElement('button')
      pop.type = 'button'
      pop.textContent = 'Pop out'
      pop.onclick = () => {
        if (this.#popup && !this.#popup.closed) { this.#popup.focus(); return }
        const popup = window.open('about:blank', '_blank', 'popup,width=1000,height=750')
        if (!popup) { pop!.textContent = 'Pop-out blocked — allow pop-ups'; return }
        this.#popup = popup
        const doc = popup.document
        doc.title = file.name
        const style = doc.createElement('style')
        style.textContent = 'body{margin:0;background:#101114;color:#fff;font:16px sans-serif}header{position:sticky;top:0;padding:12px;background:#101114}button{margin-right:12px;padding:8px}img{display:block;max-width:100%;max-height:calc(100vh - 65px);margin:auto}body.actual img{max-width:none;max-height:none;margin:0}'
        doc.head.append(style)
        const bar = doc.createElement('header')
        const toggle = document.createElement('button')
        toggle.textContent = 'Actual size'
        toggle.onclick = () => { toggle.textContent = doc.body.classList.toggle('actual') ? 'Fit to window' : 'Actual size' }
        const label = document.createElement('span')
        label.textContent = file.name
        bar.append(toggle, label)
        const picture = setLocalImage(doc.createElement('img'), { fallbackUrl: file.url, displayUrl: file.displayUrl })
        picture.alt = file.name
        doc.body.replaceChildren(bar, picture)
      }
    }

    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Close'
    close.onclick = () => dialog.close()
    header.append(title)
    if (!untrusted || kind === 'image') header.append(size)
    if (pop) header.append(pop)
    header.append(close)
    dialog.append(header, surface)
    dialog.addEventListener('close', () => {
      preview?.destroy()
      if (this.#preview === preview) this.#preview = undefined
      dialog.remove()
      if (this.#dialog === dialog) this.#dialog = undefined
      if (trigger.isConnected) trigger.focus({ preventScroll: true })
    })
    document.body.append(dialog)
    this.#dialog = dialog
    dialog.showModal()
  }

  closeUrl(url: string): void { if (this.#url === url) this.close() }

  close(): void {
    this.#dialog?.close()
    this.#dialog = undefined
    this.#preview?.destroy()
    this.#preview = undefined
    this.#popup?.close()
    this.#popup = undefined
    this.#url = undefined
    if (this.#returnFocus?.isConnected) this.#returnFocus.focus({ preventScroll: true })
    this.#returnFocus = undefined
  }
}
