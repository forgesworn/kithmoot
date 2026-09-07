import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { unwrapSignal, wrapSignal } from './signal.js'
import { SignalGuard } from './signal-guard.js'

const senderSk = generateSecretKey()
const recipientSk = generateSecretKey()
const recipient = getPublicKey(recipientSk)
const roomId = 'ab'.repeat(32)
const now = 1_800_000_000
const body = { type: 'offer' as const, roomId, sdp: 'v=0\r\n' }
function signed(kind: number, content: string, key = senderSk, at = now, tags = [['p', recipient]]) {
  return finalizeEvent({ kind, content, created_at: at, tags }, key)
}
function encrypt(value: unknown, key: Uint8Array) {
  return nip44.v2.encrypt(JSON.stringify(value), nip44.v2.utils.getConversationKey(key, recipient))
}
function sealed(change: Record<string, unknown> = {}, sealKey = senderSk, sealAt = now - 86400) {
  const event = { ...signed(20462, JSON.stringify(body)), ...change }
  const { sig: _sig, ...rumor } = event
  rumor.id = getEventHash(rumor)
  const seal = signed(13, encrypt(rumor, sealKey), sealKey, sealAt, [])
  const ephemeral = generateSecretKey()
  return signed(21059, encrypt(seal, ephemeral), ephemeral, now - 86400)
}

describe('M2 signalling compatibility', () => {
  it('emits expiry without disclosing the room, sender or SDP', () => {
    const wrap = wrapSignal(body, { senderSk, recipientPubkey: recipient })
    expect(wrap.tags).toContainEqual(['expiration', String(wrap.created_at + 60)])
    const key = nip44.v2.utils.getConversationKey(recipientSk, wrap.pubkey)
    const inner = JSON.parse(nip44.v2.decrypt(wrap.content, key))
    expect(inner.kind).toBe(20462)
    expect(inner.tags).toContainEqual(['call-id', roomId])
    expect(inner.tags).toContainEqual(['kithmoot', '1'])
    expect(inner.tags).toContainEqual(['alt', 'KithMoot call signalling'])
    expect(JSON.stringify(wrap)).not.toContain(roomId)
    expect(JSON.stringify(wrap)).not.toContain(getPublicKey(senderSk))
  })

  it('accepts a sealed signal using the innermost time, despite randomised outer times', () => {
    expect(unwrapSignal(sealed(), { recipientSk, roomId, now })).toEqual({ from: getPublicKey(senderSk), body })
  })

  it('rejects a seal author impersonating the rumor author', () => {
    expect(unwrapSignal(sealed({}, generateSecretKey()), { recipientSk, roomId, now })).toBeNull()
  })

  it('rejects a stale rumor inside a fresh seal and wrap', () => {
    expect(unwrapSignal(sealed({ created_at: now - 21 }, senderSk, now), { recipientSk, roomId, now })).toBeNull()
  })

  it('keeps accepting old signed inner signals without the new tags', () => {
    const ephemeral = generateSecretKey()
    const wrap = signed(21059, encrypt(signed(20462, JSON.stringify(body)), ephemeral), ephemeral)
    expect(unwrapSignal(wrap, { recipientSk, roomId, now })).toEqual({ from: getPublicKey(senderSk), body })
  })

  it('bounds anonymous unwrap work independently of fresh sender identities and recovers', () => {
    const guard = new SignalGuard()
    let admitted = 0
    for (let i = 0; i < 10000; i++) {
      if (guard.admitUnwrap(now)) admitted++
    }
    expect(admitted).toBeGreaterThanOrEqual(24 * 120)
    expect(admitted).toBeLessThan(10000)
    expect(guard.admitUnwrap(now + 20)).toBe(true)
  })
})
