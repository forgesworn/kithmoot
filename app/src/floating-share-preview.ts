import type { ShareSource } from './share-viewer.js'

/**
 * A floating window holding this device's own screen-share preview and its
 * marks overlay, for the one moment the ordinary preview tile is not
 * enough: a person presenting is looking at the window or screen they are
 * sharing, not at KithMoot's own small picture of it, so a mark drawn there
 * goes unseen unless something can float above whatever they are actually
 * looking at.
 *
 * Document Picture-in-Picture is the only web platform feature that keeps a
 * page's own DOM on screen above other windows without turning it into a
 * separate tab - see
 * https://developer.mozilla.org/docs/Web/API/Document_Picture-in-Picture_API.
 * Support today is Chromium's desktop browsers only; everywhere else, and
 * whenever this window is not open, `main.ts` falls back to a notice - see
 * `notifyDrawingOnMyShare`.
 *
 * Kept deliberately small and apart from `ShareMarks` and `ShareViewer`:
 * this reuses `ShareViewer.overlay` on a video element of its own, handed
 * in by the caller, rather than reaching into either class's own state.
 */

/** The shape this module needs of a Document Picture-in-Picture window -
 *  structural rather than the DOM lib's own type, so a test can hand in a
 *  window built from `document.implementation.createHTMLDocument`. */
export interface FloatingPipWindow extends EventTarget {
  readonly document: Document
  readonly closed?: boolean
  close(): void
}

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<FloatingPipWindow>
  readonly window: FloatingPipWindow | null
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture
  }
}

/** Whether this browser offers a Document Picture-in-Picture window at all. */
export function floatingPreviewSupported(win: Window = window): boolean {
  return typeof win.documentPictureInPicture?.requestWindow === 'function'
}

export interface FloatingSharePreviewOptions {
  /** The live track to show, or undefined once sharing has stopped. */
  track: () => MediaStreamTrack | undefined
  /** Paints the marks overlay on a preview video - `ShareViewer.overlay`,
   *  handed in so this module never reaches into `ShareViewer`'s own state. */
  overlay: (video: HTMLVideoElement, shareId: () => string | undefined) => () => void
  /** The current share, so the overlay knows which marks are its own. */
  source: () => ShareSource | undefined
  /** Where to request the window from - `window` in production, a stub
   *  built around a detached document in tests. */
  win?: Window
}

const PIP_WIDTH = 360
const PIP_HEIGHT = 240

/** Opens and owns one floating window at a time. */
export class FloatingSharePreview {
  readonly #opts: FloatingSharePreviewOptions
  #pip?: FloatingPipWindow
  #dispose?: () => void

  constructor(opts: FloatingSharePreviewOptions) { this.#opts = opts }

  /** Whether a floating window is open right now. */
  get isOpen(): boolean { return this.#pip !== undefined }

  /**
   * Opens the floating window. Must be called from a user gesture - a click
   * handler - which is the platform's own rule for the request, not one
   * this method adds. A no-op wherever the platform has no such window.
   */
  async open(): Promise<void> {
    const win = this.#opts.win ?? window
    const dpip = win.documentPictureInPicture
    if (!dpip) return
    this.close()
    const pip = await dpip.requestWindow({ width: PIP_WIDTH, height: PIP_HEIGHT })
    this.#pip = pip
    const doc = pip.document
    doc.title = 'Drawings on your share'
    // The same split `ShareViewer#popOut` makes for its own pop-out window:
    // published CSS as stylesheet links, development CSS as the style nodes
    // Vite injects in place of them.
    for (const sheet of win.document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
      const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = sheet.href; doc.head.append(link)
    }
    for (const style of win.document.querySelectorAll('style[data-vite-dev-id]')) doc.head.append(style.cloneNode(true))
    const rules = doc.createElement('style')
    rules.textContent = 'body { margin: 0; background: #080b0d; overflow: hidden; position: relative; }' +
      'video { display: block; width: 100%; height: 100%; object-fit: contain; }'
    doc.head.append(rules)
    const video = doc.createElement('video')
    video.autoplay = true; video.muted = true; video.playsInline = true
    doc.body.append(video)
    const track = this.#opts.track()
    if (track) { video.srcObject = new MediaStream([track]); void video.play().catch(() => {}) }
    const removeOverlay = this.#opts.overlay(video, () => this.#opts.source()?.id)
    // Fires when the person closes the floating window themselves, from its
    // own chrome rather than ours - the same event `ShareViewer#mount` uses
    // to notice its pop-out window closing.
    const onClose = () => this.close()
    pip.addEventListener('pagehide', onClose)
    this.#dispose = () => {
      removeOverlay()
      pip.removeEventListener('pagehide', onClose)
      video.pause()
      video.srcObject = null
    }
  }

  /** Closes the window, if one is open. Safe to call at any time, including
   *  from a listener on the window's own close. */
  close(): void {
    this.#dispose?.()
    this.#dispose = undefined
    const pip = this.#pip
    this.#pip = undefined
    if (pip && pip.closed !== true) pip.close()
  }
}
