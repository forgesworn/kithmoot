export type AttachmentPreviewKind = 'image' | 'audio' | 'video' | 'pdf'

export interface AttachmentPreviewInit {
  type: 'kithmoot:attachment-preview:init'
  kind: AttachmentPreviewKind
  blob: Blob
}

export interface AttachmentPreviewActualSize {
  type: 'kithmoot:attachment-preview:actual-size'
  actual: boolean
}

export const ATTACHMENT_PREVIEW_INIT = 'kithmoot:attachment-preview:init' as const
export const ATTACHMENT_PREVIEW_ACTUAL_SIZE = 'kithmoot:attachment-preview:actual-size' as const

export function previewAcceptsBlob(kind: AttachmentPreviewKind, blob: Blob): boolean {
  const mime = blob.type.split(';')[0]!.trim().toLowerCase()
  if (kind === 'pdf') return mime === 'application/pdf'
  return mime.startsWith(`${kind}/`)
}
