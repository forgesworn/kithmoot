import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { bytesToHex } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'
import { generateRoomSecret, deriveRoom, encodeJoinUrl, decodeJoinUrl } from './room.js'

describe('deriveRoom', () => {
  it('derives a 64-char hex room id and a 32-byte room key', () => {
    const secret = new Uint8Array(32).fill(7)
    const { roomId, roomKey } = deriveRoom(secret)
    expect(roomId).toMatch(/^[0-9a-f]{64}$/)
    expect(roomKey).toBeInstanceOf(Uint8Array)
    expect(roomKey.length).toBe(32)
  })

  it('is deterministic', () => {
    const secret = new Uint8Array(32).fill(7)
    expect(deriveRoom(secret).roomId).toBe(deriveRoom(secret).roomId)
  })

  it('separates the id from the key so the id never reveals the key', () => {
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
    const keyHex = bytesToHex(roomKey)
    expect(roomId).not.toBe(keyHex)
  })

  it('gives different rooms different ids', () => {
    const a = deriveRoom(new Uint8Array(32).fill(1))
    const b = deriveRoom(new Uint8Array(32).fill(2))
    expect(a.roomId).not.toBe(b.roomId)
  })

  it('rejects a secret that is not 32 bytes', () => {
    expect(() => deriveRoom(new Uint8Array(16))).toThrow(/32 bytes/)
  })
})

describe('generateRoomSecret', () => {
  it('returns 32 random bytes that differ between calls', () => {
    const a = generateRoomSecret()
    const b = generateRoomSecret()
    expect(a.length).toBe(32)
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
  })
})

describe('join URLs', () => {
  const secret = new Uint8Array(32).fill(3)
  const relays = ['wss://relay.damus.io', 'wss://nos.lol']

  it('round-trips the secret and relay hints', () => {
    const url = encodeJoinUrl('https://kithmoot.com/j', secret, relays)
    const decoded = decodeJoinUrl(url)
    expect(bytesToHex(decoded.secret)).toBe(bytesToHex(secret))
    expect(decoded.relays).toEqual(relays)
  })

  it('puts the secret in the fragment, never the path or query', () => {
    const url = encodeJoinUrl('https://kithmoot.com/j', secret, relays)
    const parsed = new URL(url)
    expect(parsed.hash.length).toBeGreaterThan(1)
    expect(parsed.search).toBe('')
    expect(parsed.pathname).toBe('/j')
    // The secret must not be recoverable from anything the server receives.
    const serverVisible = parsed.origin + parsed.pathname + parsed.search
    expect(serverVisible).not.toContain(base64urlnopad.encode(secret))
  })

  it('throws on a URL with no fragment', () => {
    expect(() => decodeJoinUrl('https://kithmoot.com/j')).toThrow(/fragment/)
  })

  it('throws on a corrupted fragment', () => {
    expect(() => decodeJoinUrl('https://kithmoot.com/j#not-valid-base64!!')).toThrow()
  })
})

describe('browser compatibility', () => {
  it('never references the Node-only Buffer global from src/', () => {
    // This library ships to a browser PWA as well as to Node. Buffer does not
    // exist in a browser, so a regression here would silently break the app
    // rather than fail a typecheck (Buffer is typed as a global by @types/node).
    const srcDir = new URL('.', import.meta.url)
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    for (const file of files) {
      const contents = readFileSync(new URL(file, srcDir), 'utf8')
      expect(contents, `${file} must not reference Buffer`).not.toMatch(/\bBuffer\b/)
    }
  })
})
