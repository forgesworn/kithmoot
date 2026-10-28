import { describe, expect, it } from 'vitest'
import { verifyEvent } from 'nostr-tools/pure'
import { claimSpryPairing, newSpryKey, parseSpryOffer, parseSpryPairingLink, spryCredentials, spryEndpoint, spryHash, spryRequest,
  spryRegisterDevices, spryVouch, spryRemoveGrant, SpryRequestError, SHARED_RELAY_UNAVAILABLE, type SpryPairing } from './spry.js'
import { getPublicKey } from 'nostr-tools/pure'

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
    const own: SpryPairing = { v: 1, endpoint, id: code, secretKey: newSpryKey() }
    await expect(spryCredentials({ ...offer, expiresAt: now - 1 }, newSpryKey(), fetch, own)).rejects.toThrow(/expired/)
    await expect(spryCredentials({ ...offer, expiresAt: now - 1 }, newSpryKey())).rejects.toThrow(SHARED_RELAY_UNAVAILABLE)
  })
  it('bounds hostile response bodies and sanitises failure text', async () => {
    await expect(spryRequest(endpoint, '/v1/credentials', {}, newSpryKey(), async () => new Response('a'.repeat(8193)))).rejects.toThrow(/could not connect/)
    await expect(spryRequest(endpoint, '/v1/credentials', {}, newSpryKey(), async () => { throw new Error('private-token-and-address') })).rejects.not.toThrow(/private-token/)
  })
})

describe('Spry refusal wording', () => {
  const now = () => Math.floor(Date.now() / 1000)
  const offer = () => ({ v: 1 as const, endpoint, token: code, expiresAt: now() + 3600 })
  const own: SpryPairing = { v: 1, endpoint, id: code, secretKey: '01'.repeat(32) }
  it('keeps the pairing hint for this device\'s own relay and carries the status', async () => {
    const error = await spryCredentials(offer(), newSpryKey(), async () => Response.json({ error: 'Call access has expired.' }, { status: 403 }), own).catch(e => e)
    expect(error).toBeInstanceOf(SpryRequestError)
    expect(error.status).toBe(403)
    expect(error.message).toMatch(/Check the pairing in Connections/)
  })
  it('gives a guest using another member\'s relay no pairing hint, refused or unreachable', async () => {
    for (const fetcher of [async () => Response.json({ error: 'Call access has expired.' }, { status: 403 }), async () => { throw new TypeError('offline') }] as (typeof fetch)[]) {
      const error = await spryCredentials(offer(), newSpryKey(), fetcher).catch(e => e)
      expect(error.message).toBe(SHARED_RELAY_UNAVAILABLE)
      expect(error.message).not.toMatch(/pairing|Connections/)
    }
    const other: SpryPairing = { ...own, endpoint: 'https://mine.example' }
    expect((await spryCredentials(offer(), newSpryKey(), async () => new Response('', { status: 503 }), other).catch(e => e)).message).toBe(SHARED_RELAY_UNAVAILABLE)
  })
  it('reports 0 for an unreachable node and the HTTP status otherwise', async () => {
    expect((await spryRequest(endpoint, '/v1/grants', {}, newSpryKey(), async () => { throw new TypeError('x') }).catch(e => e)).status).toBe(0)
    expect((await spryRequest(endpoint, '/v1/grants/devices', {}, newSpryKey(), async () => new Response('', { status: 404 })).catch(e => e)).status).toBe(404)
    expect((await spryRequest(endpoint, '/v1/grants/devices', {}, newSpryKey(), async () => new Response('', { status: 409 })).catch(e => e)).status).toBe(409)
  })
})

describe('room grant registration requests', () => {
  const pair: SpryPairing = { v: 1, endpoint, id: 'c'.repeat(43), secretKey: '02'.repeat(32) }
  const offer = { v: 1 as const, endpoint, token: code, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
  const k1 = getPublicKey(new Uint8Array(32).fill(3)), k2 = getPublicKey(new Uint8Array(32).fill(4))
  const capture = (answer: object) => {
    const sent: { url: string; body: Record<string, unknown>; signer: string }[] = []
    const fetcher: typeof fetch = async (url, options) => {
      const event = JSON.parse(atob((options!.headers as Record<string, string>).Authorization.slice(6)))
      sent.push({ url: String(url), body: JSON.parse(String(options!.body)), signer: event.pubkey })
      return Response.json(answer)
    }
    return { sent, fetcher }
  }
  it('registers with the pairing key, in the exact wire shape', async () => {
    const { sent, fetcher } = capture({ v: 1, sealed: true, enforced: true, devices: 2 })
    expect(await spryRegisterDevices(pair, offer, { add: [k1, k2], seal: true }, 7, fetcher)).toEqual({ sealed: true, enforced: true, devices: 2 })
    expect(sent[0].url).toBe(endpoint + '/v1/grants/devices')
    expect(sent[0].body).toEqual({ v: 1, pairing: pair.id, grant: code, add: [k1, k2], remove: [], seal: true, revision: 7 })
    expect(sent[0].signer).toBe(getPublicKey(Uint8Array.from(Buffer.from(pair.secretKey, 'hex'))))
    await spryRegisterDevices(pair, offer, { remove: [k1] }, 8, fetcher)
    expect(sent[1].body).toEqual({ v: 1, pairing: pair.id, grant: code, add: [], remove: [k1], revision: 8 })
  })
  it('refuses malformed changes before any request', async () => {
    const { sent, fetcher } = capture({})
    for (const change of [{ add: [k1], remove: [k1] }, { add: ['A'.repeat(64)] }, { add: Array.from({ length: 33 }, (_, i) => getPublicKey(new Uint8Array(32).fill(i + 5))) }])
      await expect(spryRegisterDevices(pair, offer, change, 1, fetcher)).rejects.toThrow('Invalid Spry request.')
    await expect(spryRegisterDevices(pair, { ...offer, endpoint: 'https://other.example' }, { add: [k1] }, 1, fetcher)).rejects.toThrow('Invalid Spry request.')
    await expect(spryVouch(offer, newSpryKey(), [], fetcher)).rejects.toThrow('Invalid Spry request.')
    await expect(spryVouch(offer, newSpryKey(), [k1, k2, k1, k2, 'x'], fetcher)).rejects.toThrow('Invalid Spry request.')
    expect(sent).toEqual([])
  })
  it('refuses a malformed answer', async () => {
    await expect(spryRegisterDevices(pair, offer, { add: [k1] }, 1, capture({ v: 1, sealed: 'yes' }).fetcher)).rejects.toThrow('Invalid Spry answer.')
  })
  it('vouches with the member\'s own key, at most four keys', async () => {
    const { sent, fetcher } = capture({ v: 1, added: 1 })
    const member = newSpryKey()
    expect(await spryVouch(offer, member, [k1], fetcher)).toBe(1)
    expect(sent[0]).toEqual({ url: endpoint + '/v1/grants/vouch', body: { v: 1, grant: code, add: [k1] }, signer: getPublicKey(Uint8Array.from(Buffer.from(member, 'hex'))) })
  })
  it('removes a grant with the pairing key', async () => {
    const { sent, fetcher } = capture({ removed: true })
    await spryRemoveGrant(pair, offer, fetcher)
    expect(sent[0]).toMatchObject({ url: endpoint + '/v1/grants/remove', body: { pairing: pair.id, grant: code } })
    await expect(spryRemoveGrant(pair, offer, capture({}).fetcher)).rejects.toThrow('Invalid Spry answer.')
  })
  it('allows only known paths', async () => {
    await expect(spryRequest(endpoint, '/v1/grants/other', {}, newSpryKey(), async () => Response.json({}))).rejects.toThrow('Invalid Spry request.')
  })
})
