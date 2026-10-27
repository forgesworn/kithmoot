import {
  ATTACHMENT_PREVIEW_ACTUAL_SIZE,
  ATTACHMENT_PREVIEW_DISPOSE,
  ATTACHMENT_PREVIEW_INIT,
  ATTACHMENT_PREVIEW_URL,
  previewAcceptsBlob,
  type AttachmentPreviewActualSize,
  type AttachmentPreviewInit,
  type AttachmentPreviewKind,
} from './attachment-preview-protocol.js'

export type { AttachmentPreviewKind } from './attachment-preview-protocol.js'

export interface AttachmentPreview {
  element: HTMLIFrameElement
  setActualSize(actual: boolean): void
  destroy(): void
}

const previews = new Map<string, Set<AttachmentPreview>>()

export function destroyAttachmentPreviews(url: string): void {
  for (const preview of previews.get(url) ?? []) preview.destroy()
  previews.delete(url)
}

export function createAttachmentPreview(
  file: { url: string; blob: Blob; name: string },
  kind: AttachmentPreviewKind,
): AttachmentPreview {
  if (!previewAcceptsBlob(kind, file.blob)) throw new TypeError(`The verified Blob is not ${kind} media.`)

  const element = document.createElement('iframe')
  element.className = `attachmentPreviewFrame attachmentPreview-${kind}`
  element.title = `Preview of ${file.name}`
  element.setAttribute('sandbox', 'allow-scripts')
  element.referrerPolicy = 'no-referrer'

  const channel = new MessageChannel()
  let loaded = false
  let transferred = false
  let actual = false
  let destroyed = false
  let objectUrl: string | undefined
  channel.port1.addEventListener('message', event => {
    const data = event.data as { type?: string; url?: unknown } | null
    if (data?.type === ATTACHMENT_PREVIEW_URL && typeof data.url === 'string') objectUrl = data.url
  })
  channel.port1.start()
  const initialise = (): void => {
    if (loaded) return
    loaded = true
    const message: AttachmentPreviewInit = { type: ATTACHMENT_PREVIEW_INIT, kind, blob: file.blob }
    element.contentWindow?.postMessage(message, '*', [channel.port2])
    transferred = true
    if (actual) sendActualSize()
  }
  const sendActualSize = (): void => {
    const message: AttachmentPreviewActualSize = { type: ATTACHMENT_PREVIEW_ACTUAL_SIZE, actual }
    channel.port1.postMessage(message)
  }
  element.addEventListener('load', initialise, { once: true })
  element.src = `${import.meta.env.BASE_URL}attachment-frame.html`

  const preview: AttachmentPreview = {
    element,
    setActualSize(next: boolean): void {
      actual = next
      if (loaded) sendActualSize()
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      previews.get(file.url)?.delete(preview)
      element.removeEventListener('load', initialise)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      objectUrl = undefined
      channel.port1.postMessage({ type: ATTACHMENT_PREVIEW_DISPOSE })
      channel.port1.close()
      if (!transferred) channel.port2.close()
      element.remove()
    },
  }
  previews.set(file.url, (previews.get(file.url) ?? new Set()).add(preview))
  return preview
}
