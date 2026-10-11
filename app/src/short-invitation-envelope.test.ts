import { createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { base64urlnopad } from '@scure/base'
import { encodeRoomLink, parseRoomLink } from '../../src/link.js'
import { MAX_SHORT_INVITATION_BYTES, MAX_SHORT_INVITATION_LIFETIME, openShortInvitation, parseShortInvitationUrl, sealShortInvitation } from './short-invitation-envelope.js'

const now = 1_800_000_000
const id = Buffer.alloc(16, 7).toString('base64url')
const key = Buffer.alloc(32, 11)
const expires = now + 3600
const link = `https://z1p.app/k/${id}#${key.toString('base64url')}`
const full = (persistent = false) => encodeRoomLink('https://kithmoot.app/j/', {
  invitation: { bearer: new Uint8Array(32).fill(5), inviter: 'ab'.repeat(32), ...(persistent ? { persistent: true as const } : {}) },
  relays: ['wss://a.example'], iceUrls: ['stun:stun.example:3478'], name: 'Workshop',
})

// Independent Node implementation, using synthetic material only.
function nodeEnvelope(payload: unknown = { v: 1, url: full() }) {
  const nonce = Buffer.alloc(12, 13)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(`kithmoot-short-invite/v1:${id}:${expires}`))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()])
  return { v: 1, expires, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url') }
}

describe('short invitation envelope, without HTTP or admission', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../vectors/short-invitation-envelope.json', import.meta.url), 'utf8')).vectors as Array<{ name: string; now: number; url: string; fullInvitation: string; envelope: unknown }>
  it.each(vectors)('opens shared independent vector $name', async vector => {
    expect(await openShortInvitation(vector.url, JSON.stringify(vector.envelope), vector.now)).toBe(vector.fullInvitation)
  })
  it.each([false, true])('preserves the exact existing invitation, persistent=%s', async persistent => {
    const original = full(persistent)
    const sealed = await sealShortInvitation(id, original, expires, now)
    expect(sealed.url).toHaveLength(84)
    const recovered = await openShortInvitation(sealed.url, JSON.stringify(sealed.envelope), now)
    expect(recovered).toBe(original)
    expect(parseRoomLink(recovered)).toEqual(parseRoomLink(original))
    expect(JSON.stringify(sealed.envelope)).not.toContain(original)
  })

  it('opens independently encrypted Node data', async () => {
    expect(await openShortInvitation(link, JSON.stringify(nodeEnvelope()), now)).toBe(full())
  })

  it('Node independently authenticates browser encryption and exact plaintext', async () => {
    const sealed = await sealShortInvitation(id, full(), expires, now)
    const parsed = parseShortInvitationUrl(sealed.url)
    const encrypted = Buffer.from(sealed.envelope.ciphertext, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', parsed.key, Buffer.from(sealed.envelope.nonce, 'base64url'))
    decipher.setAAD(Buffer.from(`kithmoot-short-invite/v1:${id}:${expires}`))
    decipher.setAuthTag(encrypted.subarray(-16))
    expect(JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString())).toEqual({ v: 1, url: full() })
    parsed.key.fill(0)
  })

  it.each(['id', 'key', 'expires', 'nonce', 'ciphertext'])('rejects changed %s', async field => {
    const envelope = nodeEnvelope()
    let target = link
    if (field === 'id') target = link.replace(id, Buffer.alloc(16, 8).toString('base64url'))
    else if (field === 'key') target = link.replace(key.toString('base64url'), Buffer.alloc(32, 12).toString('base64url'))
    else if (field === 'expires') envelope.expires++
    else {
      const encoded = field === 'nonce' ? envelope.nonce : envelope.ciphertext
      const changed = Buffer.from(encoded, 'base64url'); changed[0] ^= 1
      if (field === 'nonce') envelope.nonce = changed.toString('base64url')
      else envelope.ciphertext = changed.toString('base64url')
    }
    await expect(openShortInvitation(target, JSON.stringify(envelope), now)).rejects.toThrow()
  })

  it('expires exactly at the boundary and bounds the lifetime', async () => {
    expect(await openShortInvitation(link, JSON.stringify(nodeEnvelope()), expires - 1)).toBe(full())
    await expect(openShortInvitation(link, JSON.stringify(nodeEnvelope()), expires)).rejects.toThrow()
    await expect(sealShortInvitation(id, full(), now + MAX_SHORT_INVITATION_LIFETIME + 1, now)).rejects.toThrow()
    await expect(sealShortInvitation(id, full(), expires, NaN)).rejects.toThrow()
  })

  it.each([
    link.replace('https://z1p.app', 'https://evil.example'),
    link.replace('/k/', '/other/'), link.replace('#', '?tracking=1#'),
    link + '=', link.replace('https://', 'https://guest@'),
    link.slice(0, -1) + 'B', // Non-canonical low padding bits for this key.
  ])('refuses malformed or noncanonical short URLs', value => {
    expect(() => parseShortInvitationUrl(value)).toThrow()
  })

  it.each([
    { ...nodeEnvelope(), v: 2 }, { ...nodeEnvelope(), extra: 'unknown' },
    { ...nodeEnvelope(), nonce: 'AA' }, { ...nodeEnvelope(), ciphertext: 'AA' },
    { ...nodeEnvelope(), nonce: nodeEnvelope().nonce + '=' },
    [], null,
  ])('refuses unsupported or malformed envelopes', async envelope => {
    await expect(openShortInvitation(link, JSON.stringify(envelope), now)).rejects.toThrow()
  })

  it('bounds hostile responses before decoding or parsing', async () => {
    await expect(openShortInvitation(link, ' '.repeat(MAX_SHORT_INVITATION_BYTES + 1), now)).rejects.toThrow()
    await expect(openShortInvitation(link, '💩'.repeat(MAX_SHORT_INVITATION_BYTES / 2), now)).rejects.toThrow()
  })

  it.each([
    { v: 2, url: full() }, { v: 1, url: full(), extra: 1 },
    { v: 1, url: 'https://evil.example/j/#anything' },
    { v: 1, url: full().replace('/j/#', '/j/?tracking=1#') },
    { v: 1, url: 'https://kithmoot.app/j/#invalid' },
    { v: 1, url: 'https://kithmoot.app/j/#' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ v: 99 }))) },
    { v: 1, url: encodeRoomLink('https://kithmoot.app/j/', { secret: new Uint8Array(32).fill(9), relays: [], iceUrls: [] }) },
  ])('refuses authenticated payloads that are not supported invitations', async payload => {
    await expect(openShortInvitation(link, JSON.stringify(nodeEnvelope(payload)), now)).rejects.toThrow()
  })

  it('uses independent keys and nonces for repeat sealing', async () => {
    const first = await sealShortInvitation(id, full(), expires, now)
    const second = await sealShortInvitation(id, full(), expires, now)
    expect(first.url).not.toBe(second.url)
    expect(first.envelope.nonce).not.toBe(second.envelope.nonce)
    await expect(openShortInvitation(first.url, JSON.stringify(second.envelope), now)).rejects.toThrow()
  })
})
