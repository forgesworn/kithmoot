import { describe, expect, it } from 'vitest'
import { normaliseAttachment } from './chat.js'
import { privateAttachmentLocation, privateAttachmentUrl } from './private-attachment.js'

// Existing Link fsl-scheme.json vector: canonical 32-byte node and digest.
const node = 'ugq2dinbugq2dinbugq2dinbugq2dinbugq2dinbugq2dinbugqq'
const hash = '4d'.repeat(32)
const attachment = { url: `fsl://${node}/${hash}`, sha256: hash, key: '12'.repeat(32), name: 'private.txt', type: 'text/plain', size: 65536 }

describe('existing Link references in encrypted chat attachments', () => {
  it('retains a canonical private reference without converting it to a public URL', () => {
    expect(normaliseAttachment(attachment)).toEqual(attachment)
  })
  it('continues to accept existing HTTPS attachments unchanged', () => {
    const value = { ...attachment, url: `https://files.example/${hash}` }
    expect(normaliseAttachment(value)).toEqual(value)
  })
  it('rejects a different private hash and noncanonical node padding', () => {
    expect(normaliseAttachment({ ...attachment, sha256: 'ab'.repeat(32) })).toBeNull()
    expect(normaliseAttachment({ ...attachment, url: `fsl://${node.slice(0, -1)}r/${hash}` })).toBeNull()
  })
})

describe('canonical private file locations', () => {
  it('uses the existing Link node/hash form and never supplies a network origin', () => {
    expect(privateAttachmentLocation(attachment.url, hash)).toEqual({ node, hash })
    expect(privateAttachmentUrl(node, hash)).toBe(attachment.url)
  })
  it.each([
    `fsl://${node}/${hash}.bin`, `fsl://${node}/${hash}?x=1`,
    `fsl://${node}/${hash}#x`, `fsl://user@${node}/${hash}`,
    `fsl://${node}:443/${hash}`, `fsl://${node}/a/../${hash}`,
    `fsl://${node}/%34${hash.slice(1)}`, `fsl://${node}/${hash.toUpperCase()}`,
    `FSL://${node}/${hash}`, `fsl://${node.toUpperCase()}/${hash}`,
    `fsl://${node}/${hash}/`, `ws://${node}/${hash}`,
    `http://${node}/${hash}`, `https://${node}/${hash}`,
  ])('does not reinterpret %s as a private location', value => {
    expect(privateAttachmentLocation(value, hash)).toBeUndefined()
  })
})
