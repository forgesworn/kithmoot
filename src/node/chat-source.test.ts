import { it, expect } from 'vitest'
import { encryptEnvelopeBlob } from '../attachment.js'
import type { ChatMessage } from '../chat.js'
import { readChatSource } from './chat-source.js'

it('reads every character from an authenticated document, with explicit paging and no key disclosure', async () => {
  const full = '  ' + 'X'.repeat(15997) + '🐱\n' + 'A long line.\n'.repeat(6000) + 'END  '
  const sealed = await encryptEnvelopeBlob(new Blob([full]), { name: 'message.txt', type: 'text/plain' })
  const message = { id: 'source', participant: 'ab'.repeat(32), text: 'Short preview', attachments: [{ url: 'https://files.example/source', sha256: sealed.sha256, key: sealed.key, name: sealed.name, type: sealed.type, size: sealed.envelope.size }] } as ChatMessage
  const fetcher: typeof fetch = async () => new Response(sealed.envelope)
  let result = '', offset = 0
  do {
    const page = await readChatSource([message], { messageId: message.id, participant: message.participant, attachment: 0, offset, limit: 16000 }, fetcher)
    expect(JSON.stringify(page)).not.toContain(sealed.key)
    result += page.text
    if (page.nextOffset === null) break
    offset = page.nextOffset
  } while (true)
  expect(result).toBe(full)
  await expect(readChatSource([message], { messageId: message.id, participant: 'cd'.repeat(32), offset: 0, limit: 100 }, fetcher)).rejects.toThrow('not available')
  await expect(readChatSource([message], { messageId: message.id, participant: message.participant, attachment: 0, offset: 0, limit: 100 }, async () => new Response('tampered'))).rejects.toThrow('not the file')
})
