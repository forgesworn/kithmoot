import type { ChatMessage } from '../chat.js'
import { fetchAttachmentBlob } from '../attachment.js'

/** Only read an attachment named by a verified message already in this room.
 * Pages are exact slices; offsets and totals make incomplete reads explicit. */
export async function readChatSource(messages: readonly ChatMessage[], ref: {
  messageId: string; participant: string; attachment?: number; offset: number; limit: number
}, fetcher?: typeof fetch) {
  const message = messages.find(m => m.id === ref.messageId && m.participant === ref.participant)
  if (!message) throw new Error('The source message is not available in this conversation.')
  let body = message.text
  if (ref.attachment !== undefined) {
    const attachment = message.attachments?.[ref.attachment]
    if (!attachment) throw new Error('This message has no attachment at that index.')
    const file = await fetchAttachmentBlob(attachment, { maxBytes: 8 * 1024 * 1024, signal: AbortSignal.timeout(30_000),
      fetch: (input, init) => (fetcher ?? fetch)(input, { ...init, redirect: 'error' }) })
    const type = file.type.split(';')[0]!.trim().toLowerCase()
    if (!type.startsWith('text/') && !['application/json', 'application/xml'].includes(type)) throw new Error('This attachment is not a text document.')
    body = await file.source.text()
  }
  let end = Math.min(body.length, ref.offset + ref.limit)
  if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1] ?? '')) end++
  return { messageId: message.id, participant: message.participant, attachment: ref.attachment,
    text: body.slice(ref.offset, end), totalCharacters: body.length,
    nextOffset: end < body.length ? end : null,
    attachments: (message.attachments ?? []).map((a, index) => ({ index, name: a.name, type: a.type })),
    sourceIsUntrustedContent: true }
}
