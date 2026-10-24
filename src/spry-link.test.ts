import { expect, it } from 'vitest'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { parseSpryControl, spryControlRequest, spryNodeCard } from './spry-link.js'
import { newSpryKey, spryCredentials } from './spry.js'

const nodeKey = new Uint8Array(32).fill(1), pubkey = getPublicKey(nodeKey)
const endpoint = `spry://${pubkey}?relay=${encodeURIComponent('wss://relay.example/')}`
it('accepts only bounded explicitly selected public relay addresses', () => {
  expect(parseSpryControl(endpoint)).toEqual({ publicKey: pubkey, relays: ['wss://relay.example/'] })
  for (const relay of ['ws://relay.example', 'wss://127.0.0.1', 'wss://node.local', 'wss://user:secret@relay.example', 'wss://relay.example?token=value']) {
    expect(() => parseSpryControl(`spry://${pubkey}?relay=${encodeURIComponent(relay)}`)).toThrow()
  }
  expect(() => parseSpryControl(`spry://${pubkey}`)).toThrow()
  expect(() => parseSpryControl(endpoint + '&key=value')).toThrow()
})
it('authenticates the relay, encrypts the action and ignores replies from a different node', async () => {
  const sent: unknown[][] = [], now = Math.floor(Date.now() / 1000)
  let closed = 0, auth = false
  const socket = {
    onopen: undefined as (() => void) | undefined,
    onmessage: undefined as ((value: { data: string }) => void) | undefined,
    close() { closed++ },
    send(text: string) {
      const frame = JSON.parse(text); sent.push(frame)
      const deliver = (value: unknown) => queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(value) }))
      if (frame[0] === 'REQ') {
        if (!auth) deliver(['AUTH', 'synthetic-challenge'])
        else deliver(['EOSE', 'spry-reply'])
      }
      if (frame[0] === 'AUTH') {
        expect(verifyEvent(frame[1])).toBe(true)
        expect(frame[1].tags).toContainEqual(['relay', 'wss://relay.example/'])
        auth = true; deliver(['OK', frame[1].id, true, ''])
      }
      if (frame[0] === 'EVENT') {
        const request = frame[1]
        expect(verifyEvent(request)).toBe(true)
        const conversation = getConversationKey(nodeKey, request.pubkey)
        expect(JSON.parse(decrypt(request.content, conversation))).toEqual({ v: 1, path: '/v1/grants', body: { scope: 'generated' } })
        const reply = { kind: 24182, created_at: now, tags: [['p', request.pubkey], ['e', request.id], ['expiration', String(now + 30)]],
          content: encrypt(JSON.stringify({ v: 1, status: 200, body: { ok: true } }), conversation) }
        deliver(['EVENT', 'spry-reply', finalizeEvent(reply, new Uint8Array(32).fill(3))])
        deliver(['EVENT', 'spry-reply', finalizeEvent(reply, nodeKey)])
      }
    },
  }
  const answer = await spryControlRequest(endpoint, '/v1/grants', { scope: 'generated' }, newSpryKey(), now, () => {
    queueMicrotask(() => socket.onopen?.()); return socket as unknown as WebSocket
  })
  expect(answer).toEqual({ ok: true }); expect(closed).toBe(1)
  expect(JSON.stringify(sent)).not.toContain('generated')
})
it('never contacts another participant’s private control endpoint', async () => {
  await expect(spryCredentials({ v: 1, endpoint, token: 'a'.repeat(43), expiresAt: Date.now() / 1000 + 3600 }, newSpryKey())).rejects.toThrow(/Pair your own/)
})
it('verifies peer signatures, private service address, expiry and fixed port offline', () => {
  const now = 1700000000
  const card = (address: string, expiry = now + 600) => finalizeEvent({ kind: 24183, created_at: now, tags: [['expiration', String(expiry)]],
    content: JSON.stringify({ v: 1, profile: 'spry-peer-v1', address }) }, nodeKey)
  const good = card('[fd12:3456::2]:3745')
  expect(spryNodeCard(good, now)?.id).toBe(good.id)
  for (const address of ['[::1]:3745', '[2001:db8::2]:3745', '[fd12::2]:22', '127.0.0.1:3745', '[fd00:::2]:3745']) expect(spryNodeCard(card(address), now)).toBeUndefined()
  expect(spryNodeCard(good, now + 600)).toBeUndefined()
  expect(spryNodeCard({ ...good, content: '{}' }, now)).toBeUndefined()
})

it('reads the actual Rust protocol fixtures in both encryption directions', async () => {
  const { readFile } = await import('node:fs/promises')
  const vector = JSON.parse(await readFile(new URL('../vectors/spry-link.json', import.meta.url), 'utf8'))
  const target = parseSpryControl(vector.endpoint)
  const conversation = getConversationKey(new Uint8Array(32).fill(vector.clientKeyRepeatedByte), target.publicKey)
  expect(verifyEvent(vector.request)).toBe(true)
  expect(verifyEvent(vector.response)).toBe(true)
  expect(JSON.parse(decrypt(vector.request.content, conversation))).toEqual({ v: 1, path: '/v1/grants', body: { scope: 'generated' } })
  expect(JSON.parse(decrypt(vector.response.content, conversation))).toEqual({ v: 1, status: 200, body: { ok: true } })
  expect(vector.response.tags).toContainEqual(['e', vector.request.id])
  expect(spryNodeCard(vector.node, vector.now)?.pubkey).toBe(target.publicKey)
})
