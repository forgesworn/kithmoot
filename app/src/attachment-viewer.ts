/** Render decrypted images only as images, including SVG. Never navigate to
 * the attachment URL as a document, where active content could execute. */
export class AttachmentViewer {
  #dialog?: HTMLDialogElement
  #popup?: Window
  #url?: string
  #returnFocus?: HTMLElement

  open(file: { url: string; name: string }, trigger: HTMLElement): void {
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
    const img = document.createElement('img')
    img.src = file.url
    img.alt = file.name
    surface.append(img)
    const size = document.createElement('button')
    size.type = 'button'
    size.textContent = 'Actual size'
    size.setAttribute('aria-pressed', 'false')
    size.onclick = () => {
      const actual = surface.classList.toggle('actualSize')
      size.textContent = actual ? 'Fit to window' : 'Actual size'
      size.setAttribute('aria-pressed', String(actual))
    }
    const pop = document.createElement('button')
    pop.type = 'button'
    pop.textContent = 'Pop out'
    pop.onclick = () => {
      if (this.#popup && !this.#popup.closed) { this.#popup.focus(); return }
      const popup = window.open('about:blank', '_blank', 'popup,width=1000,height=750')
      if (!popup) { pop.textContent = 'Pop-out blocked — allow pop-ups'; return }
      this.#popup = popup
      const doc = popup.document
      doc.title = file.name
      const style = doc.createElement('style')
      style.textContent = 'body{margin:0;background:#101114;color:#fff;font:16px sans-serif}header{position:sticky;top:0;padding:12px;background:#101114}button{margin-right:12px;padding:8px}img{display:block;max-width:100%;max-height:calc(100vh - 65px);margin:auto}body.actual img{max-width:none;max-height:none;margin:0}'
      doc.head.append(style)
      const bar = doc.createElement('header')
      const toggle = doc.createElement('button')
      toggle.textContent = 'Actual size'
      toggle.onclick = () => { toggle.textContent = doc.body.classList.toggle('actual') ? 'Fit to window' : 'Actual size' }
      const label = doc.createElement('span')
      label.textContent = file.name
      bar.append(toggle, label)
      const picture = doc.createElement('img')
      picture.src = file.url
      picture.alt = file.name
      doc.body.replaceChildren(bar, picture)
    }
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Close'
    close.onclick = () => dialog.close()
    header.append(title, size, pop, close)
    dialog.append(header, surface)
    dialog.addEventListener('close', () => {
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
    this.#popup?.close()
    this.#popup = undefined
    this.#url = undefined
    if (this.#returnFocus?.isConnected) this.#returnFocus.focus({ preventScroll: true })
    this.#returnFocus = undefined
  }
}
