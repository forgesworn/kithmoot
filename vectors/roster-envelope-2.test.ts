import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { decodeRosterEvent, rosterEnvelope2Digest } from '../src/roster.js'

const vectors = JSON.parse(readFileSync(new URL('./roster-envelope-2.json', import.meta.url), 'utf8'))

describe('independently assembled roster envelope-2 conformance vectors', () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const decode = { ...vector.decode, roomKey: hexToBytes(vector.decode.roomKey),
        ...(vector.decode.epoch ? { epoch: { ...vector.decode.epoch, key: hexToBytes(vector.decode.epoch.key) } } : {}) }
      expect(bytesToHex(rosterEnvelope2Digest(decode.roomId, vector.event.tags[0][1],
        vector.event.pubkey, vector.event.created_at, vector.body))).toBe(vector.digest)
      expect(decodeRosterEvent(vector.event as Event, decode)).toEqual(vector.expected)
      // Re-signing a captured ciphertext under a new author cannot refresh it.
      const lifted = finalizeEvent({ kind: vector.event.kind, created_at: vector.event.created_at,
        tags: vector.event.tags, content: vector.event.content }, generateSecretKey())
      expect(decodeRosterEvent(lifted, decode)).toBeNull()
      expect(decodeRosterEvent(vector.event, { ...decode, now: decode.now + 3601 })).toBeNull()
    })
  }
})
