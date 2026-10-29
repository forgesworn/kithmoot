import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { newSpryKey, spryCredentials, SHARED_RELAY_UNAVAILABLE, SpryRequestError, type SpryOffer, type SpryPairing } from './spry.js'

// The control channel itself is covered in spry-link.test.ts; here it answers
// as a node would, so the guest's rules about the answer can be driven.
const control = vi.hoisted(() => ({ answer: vi.fn<(endpoint: string, path: string, body: object) => Promise<Record<string, unknown>>>() }))
vi.mock('./spry-link.js', async original => ({
  ...await original<typeof import('./spry-link.js')>(),
  spryControlRequest: (endpoint: string, path: string, body: object) => control.answer(endpoint, path, body),
}))

const nodeKey = new Uint8Array(32).fill(1), node = getPublicKey(nodeKey)
const endpoint = `spry://${node}?relay=${encodeURIComponent('wss://relay.example/')}`
const seconds = () => Math.floor(Date.now() / 1000)
const standardCard = (key = nodeKey, content = '{"profile":"spry-standard-v1","v":1}') =>
  finalizeEvent({ kind: 24183, created_at: seconds(), tags: [['expiration', String(seconds() + 600)]], content }, key)
const peerCard = () => finalizeEvent({ kind: 24183, created_at: seconds(), tags: [['expiration', String(seconds() + 600)]],
  content: JSON.stringify({ v: 1, profile: 'spry-peer-v1', address: '[fd12:3456::2]:3745' }) }, nodeKey)
const offer = (card = standardCard()): SpryOffer => ({ v: 1, endpoint, token: 'a'.repeat(43), expiresAt: seconds() + 86400, node: card })
const answer = (urls: string[], card: object | null = standardCard()) => {
  const expiresAt = seconds() + 300
  return { urls, username: `${expiresAt}:${'b'.repeat(24)}`, credential: 'a'.repeat(27) + '=', expiresAt, accessExpiresAt: expiresAt + 86400, ...(card ? { node: card } : {}) }
}
const URLS = ['turn:1.2.3.4:51000?transport=udp', 'turn:1.2.3.4:51001?transport=tcp']

afterEach(() => control.answer.mockReset())

describe('another member\'s standard spry: offer', () => {
  it('is redeemed over control, keeping the node\'s standard card and its two TURN URLs', async () => {
    control.answer.mockResolvedValue(answer(URLS))
    const credential = await spryCredentials(offer(), newSpryKey())
    expect(credential.urls).toEqual(URLS)
    expect(credential.node?.content).toBe('{"profile":"spry-standard-v1","v":1}')
    expect(control.answer).toHaveBeenCalledWith(endpoint, '/v1/credentials', { grant: 'a'.repeat(43) })
  })
  it('never contacts a private node\'s offer, or one without a standard card', async () => {
    for (const card of [peerCard(), undefined, standardCard(new Uint8Array(32).fill(3))]) {
      await expect(spryCredentials({ ...offer(), node: card }, newSpryKey())).rejects.toThrow(/Pair your own/)
    }
    expect(control.answer).not.toHaveBeenCalled()
  })
  it('refuses an answer whose card is missing, a peer card, or another key\'s', async () => {
    for (const card of [null, peerCard(), standardCard(new Uint8Array(32).fill(3))]) {
      control.answer.mockResolvedValueOnce(answer(URLS, card))
      await expect(spryCredentials(offer(), newSpryKey())).rejects.toThrow('Invalid Spry node answer.')
    }
  })
  it('refuses TURN URLs that point into a private network, at a name, or over turns:', async () => {
    for (const urls of [['turn:192.168.1.10:51000?transport=udp'], ['turn:127.0.0.1:51000?transport=udp'], ['turn:relay.example:3478?transport=udp'],
      ['turns:1.2.3.4:5349?transport=tcp'], [...URLS, 'turn:1.2.3.4:51002?transport=udp'], ['turn:1.2.3.4:51000?transport=udp', 'turn:1.2.3.5:51001?transport=tcp']]) {
      control.answer.mockResolvedValueOnce(answer(urls))
      await expect(spryCredentials(offer(), newSpryKey())).rejects.toThrow('Invalid Spry relay answer.')
    }
  })
  it('admits 127.0.0.1 only in a local acceptance build', async () => {
    const loop = ['turn:127.0.0.1:41000?transport=udp', 'turn:127.0.0.1:41000?transport=tcp']
    control.answer.mockResolvedValueOnce(answer(loop))
    await expect(spryCredentials(offer(), newSpryKey())).rejects.toThrow('Invalid Spry relay answer.')
    control.answer.mockResolvedValueOnce(answer(loop))
    expect((await spryCredentials(offer(), newSpryKey(), fetch, undefined, { loopbackTurn: true })).urls).toEqual(loop)
    control.answer.mockResolvedValueOnce(answer(['turn:10.0.0.1:41000?transport=udp']))
    await expect(spryCredentials(offer(), newSpryKey(), fetch, undefined, { loopbackTurn: true })).rejects.toThrow('Invalid Spry relay answer.')
  })
  it('gives a guest whose redemption is refused no pairing hint', async () => {
    control.answer.mockRejectedValueOnce(new SpryRequestError(403))
    const error = await spryCredentials(offer(), newSpryKey()).catch(e => e)
    expect(error).toBeInstanceOf(SpryRequestError)
    expect(error.status).toBe(403)
    expect(error.message).toBe(SHARED_RELAY_UNAVAILABLE)
  })
})

describe('this device\'s own spry: pairing', () => {
  const own: SpryPairing = { v: 1, endpoint, id: 'c'.repeat(43), secretKey: '01'.repeat(32) }
  it('accepts its own standard node, under the standard URL rule', async () => {
    control.answer.mockResolvedValueOnce(answer(URLS))
    expect((await spryCredentials(offer(), newSpryKey(), fetch, own)).urls).toEqual(URLS)
    control.answer.mockResolvedValueOnce(answer(['turn:10.0.0.1:41000?transport=udp']))
    await expect(spryCredentials(offer(), newSpryKey(), fetch, own)).rejects.toThrow('Invalid Spry relay answer.')
  })
  it('keeps its own private node\'s peer card and rule', async () => {
    control.answer.mockResolvedValueOnce(answer(['turn:node.example:3745?transport=udp'], peerCard()))
    expect((await spryCredentials({ ...offer(), node: undefined }, newSpryKey(), fetch, own)).node?.content).toContain('spry-peer-v1')
  })
})
