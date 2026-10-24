import { describe, expect, it } from 'vitest'
import { verifyEvent } from 'nostr-tools/pure'
import { claimSpryPairing, newSpryKey, parseSpryOffer, parseSpryPairingLink, spryCredentials, spryEndpoint, spryHash, spryRequest } from './spry.js'

const endpoint = 'https://relay.example:3744', code = 'a'.repeat(43)
describe('Spry operator access', () => {
  it('rejects private and malformed endpoints before a request', () => {
    for (const value of ['http://relay.example', 'https://127.0.0.1', 'https://10.0.0.1', 'https://[::1]', 'https://node.local',
      'https://user:secret@relay.example', 'https://relay.example/path', 'https://relay.example?secret=value']) expect(() => spryEndpoint(value)).toThrow()
  })
  it('projects only the room capability and bounds pairing lifetime', () => {
    expect(parseSpryOffer({ v: 1, endpoint, token: code, expiresAt: 12, roomKey: 'never copy', secretKey: 'never copy' }))
      .toEqual({ v: 1, endpoint, token: code, expiresAt: 12 })
    expect(parseSpryOffer({ v: 1, endpoint, token: 'bad', expiresAt: 12 })).toBeUndefined()
    const link = (expiresAt: number) => '#spry=' + btoa(JSON.stringify({ v: 1, endpoint, code, expiresAt })).replaceAll('=', '')
    expect(parseSpryPairingLink(link(300), 100).code).toBe(code)
    expect(() => parseSpryPairingLink(link(100), 100)).toThrow(/expired/)
    expect(() => parseSpryPairingLink(link(1000), 100)).toThrow(/expired/)
  })
  it('signs the exact body and endpoint, without cookies, referrers or redirects', async () => {
    await spryRequest(endpoint, '/v1/credentials', { grant: code }, newSpryKey(), async (url, options) => {
      expect(url).toBe(endpoint + '/v1/credentials')
      expect(options).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' })
      const event = JSON.parse(atob((options!.headers as Record<string, string>).Authorization.slice(6)))
      expect(verifyEvent(event)).toBe(true)
      expect(event.tags).toContainEqual(['payload', spryHash(String(options!.body))])
      expect(event.tags).toContainEqual(['u', String(url)])
      return Response.json({ ok: true })
    })
  })
  it('binds the claim response to the node and never exposes the pairing key', async () => {
    const pairing = await claimSpryPairing({ endpoint, code, expiresAt: Math.floor(Date.now() / 1000) + 100 }, async (_url, options) => {
      expect(String(options?.body)).not.toContain('secretKey')
      return Response.json({ version: 1, endpoint, id: code })
    })
    expect(pairing.secretKey).toHaveLength(64)
    await expect(claimSpryPairing({ endpoint, code, expiresAt: 100 }, async () => Response.json({ version: 1, endpoint: 'https://stranger.example', id: code }))).rejects.toThrow()
  })
  it('never hands credentials to an endpoint named by a malicious response', async () => {
    const now = Math.floor(Date.now() / 1000), offer = { v: 1 as const, endpoint, token: code, expiresAt: now + 300 }
    const response = { urls: ['turn:stranger.example:3478?transport=udp'], username: `${now + 200}:${'a'.repeat(24)}`, credential: 'a'.repeat(27) + '=', expiresAt: now + 200 }
    await expect(spryCredentials(offer, newSpryKey(), async () => Response.json(response))).rejects.toThrow(/Invalid/)
    await expect(spryCredentials({ ...offer, expiresAt: now - 1 }, newSpryKey())).rejects.toThrow(/expired/)
  })
  it('bounds hostile response bodies and sanitises failure text', async () => {
    await expect(spryRequest(endpoint, '/v1/credentials', {}, newSpryKey(), async () => new Response('a'.repeat(8193)))).rejects.toThrow(/could not connect/)
    await expect(spryRequest(endpoint, '/v1/credentials', {}, newSpryKey(), async () => { throw new Error('private-token-and-address') })).rejects.not.toThrow(/private-token/)
  })
})
