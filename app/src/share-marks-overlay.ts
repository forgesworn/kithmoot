type Bridge = NonNullable<Window['kithmootDesktop']>
const MARKS_URL = 'about:blank#kithmoot-share-marks'

export interface ShareMarksOverlayOptions {
  /** Paints the marks for a share onto a canvas, and keeps doing so until
   *  the returned function is called: `ShareViewer#areaOverlay`. */
  paint: (canvas: HTMLCanvasElement, shareId: () => string | undefined) => () => void
}

/**
 * Marks other people draw on a whole-screen share, shown on the screen being
 * shared (desktop app only, not on Wayland).
 *
 * A whole-screen share keeps its own live preview off screen, because it would
 * film itself (`applySelfMirrorGuard` in main.ts), so the marks drawn for the
 * person sharing landed on a blank tile they were not looking at, and drawing
 * looked broken from both ends. This is a see-through window over the whole
 * shared display, placed by the main process (`desktop/marks-overlay.mjs`),
 * that never takes a click, a key or the focus. A mark's place is a fraction
 * of the shared picture, and the picture is that display edge to edge, so the
 * canvas is the display and the marks fall where they were drawn.
 *
 * Nothing here for a window share: another program's window keeps its own
 * live preview to draw on, and this process cannot follow where it is.
 */
export class ShareMarksOverlay {
  #popup: Window | undefined
  #dispose: (() => void) | undefined

  constructor(private readonly bridge: Bridge | undefined, private readonly opts: ShareMarksOverlayOptions) {}

  get supported(): boolean { return Boolean(this.bridge?.supportsRedaction) }
  get isOpen(): boolean { return Boolean(this.#popup && !this.#popup.closed) }

  /** Shows the marks for `shareId` over the shared display. The caller says
   *  the share is a whole screen; the main process closes the window again if
   *  the capture it recorded is anything else. */
  open(shareId: () => string | undefined): void {
    if (!this.supported) return
    this.close()
    const popup = window.open(MARKS_URL, '_blank', 'popup,width=400,height=300')
    if (!popup) return
    this.#popup = popup
    const doc = popup.document
    doc.title = 'Marks on your screen'
    const style = doc.createElement('style')
    style.textContent = 'html,body{margin:0;width:100%;height:100%;background:transparent!important;overflow:hidden;pointer-events:none}canvas{display:block;width:100vw;height:100vh}'
    doc.head.append(style)
    const canvas = doc.createElement('canvas')
    canvas.className = 'shareMarksOverlay'
    canvas.setAttribute('aria-hidden', 'true')
    doc.body.append(canvas)
    const stopPainting = this.opts.paint(canvas, shareId)
    const gone = () => { if (this.#popup === popup) this.close() }
    popup.addEventListener('pagehide', gone)
    this.#dispose = () => { popup.removeEventListener('pagehide', gone); stopPainting() }
  }

  close(): void {
    this.#dispose?.()
    this.#dispose = undefined
    const popup = this.#popup
    this.#popup = undefined
    if (popup && !popup.closed) popup.close()
  }
}
