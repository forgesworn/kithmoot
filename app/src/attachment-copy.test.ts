import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { encryptEnvelopeBlob } from '../../src/attachment.js'
import { attachmentCopyError, copyEnvelopeToWildbloom } from './attachment-copy.js'

const server = 'https://files.example'

async function sealedFile() {
  return encryptEnvelopeBlob(new Blob(['room plaintext']), { name: 'notes.txt', type: 'text/plain' })
}

describe('copyEnvelopeToWildbloom', () => {
  it('uploads the exact encrypted bytes under the selected identity without another download or announcement', async () => {
    const sealed = await sealedFile()
    const identity = localIdentity(generateSecretKey())
    const current = vi.fn()
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Uint8Array(await (init!.body as Blob).arrayBuffer())).toEqual(new Uint8Array(await sealed.envelope.arrayBuffer()))
      const authorization = init!.headers as Record<string, string>
      const event = JSON.parse(Buffer.from(authorization.Authorization.slice(6), 'base64').toString())
      expect(event.pubkey).toBe(identity.pubkey)
      expect(event.tags).toContainEqual(['x', sealed.sha256])
      expect(event.tags).toContainEqual(['server', 'files.example'])
      return new Response(JSON.stringify({ url: `${server}/${sealed.sha256}`, sha256: sealed.sha256, size: sealed.envelope.size }), { status: 201 })
    })
    const result = await copyEnvelopeToWildbloom({ server, envelope: sealed.envelope, sha256: sealed.sha256, identity, current, fetch: fetch as typeof fetch })
    expect(result.url).toBe(`${server}/${sealed.sha256}`)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(current).toHaveBeenCalled()
    await sealed.dispose?.()
  })

  it('refuses changed ciphertext before asking the signer or network', async () => {
    const sealed = await sealedFile()
    const identity = localIdentity(generateSecretKey())
    const signEvent = vi.spyOn(identity, 'signEvent')
    const fetch = vi.fn()
    const changed = new Blob([sealed.envelope, new Uint8Array([0])])
    await expect(copyEnvelopeToWildbloom({ server, envelope: changed, sha256: sealed.sha256, identity, current: () => {}, fetch })).rejects.toThrow(/changed/)
    expect(signEvent).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await sealed.dispose?.()
  })

  it('refuses a signature from another identity and stops before upload', async () => {
    const sealed = await sealedFile()
    const identity = localIdentity(generateSecretKey())
    const other = generateSecretKey()
    identity.signEvent = async template => finalizeEvent(template, other)
    const fetch = vi.fn()
    await expect(copyEnvelopeToWildbloom({ server, envelope: sealed.envelope, sha256: sealed.sha256, identity, current: () => {}, fetch })).rejects.toThrow(/different identity/)
    expect(fetch).not.toHaveBeenCalled()
    await sealed.dispose?.()
  })

  it('rechecks the destination after signing and before sending', async () => {
    const sealed = await sealedFile()
    const identity = localIdentity(generateSecretKey())
    const fetch = vi.fn()
    let checks = 0
    const current = () => { if (++checks > 1) throw new Error('Your account or Wildbloom destination changed. Review it and try again.') }
    await expect(copyEnvelopeToWildbloom({ server, envelope: sealed.envelope, sha256: sealed.sha256, identity, current, fetch })).rejects.toThrow(/destination changed/)
    expect(fetch).not.toHaveBeenCalled()
    await sealed.dispose?.()
  })
})

describe('attachmentCopyError', () => {
  it('explains owner refusal, network failure and size limits', () => {
    expect(attachmentCopyError(new Error('The server refused the upload authorisation (403).'), 'files.example')).toContain('Use an identity your Wildbloom Node allows')
    expect(attachmentCopyError(new Error('Could not reach files.example.'), 'files.example')).toBe('Couldn’t reach files.example. Try again.')
    expect(attachmentCopyError(new Error('The server will not take a file this big (413).'), 'files.example')).toBe('files.example won’t take a file this big.')
  })
})
