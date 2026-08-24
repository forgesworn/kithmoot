// Loads `kithmoot-vectors.json` and checks it two ways for every vector
// that involves signing or encryption:
//
//   1. Recomputing the bytes from the vector's own recorded inputs (secret
//      keys, aux-rand, NIP-44 nonces) via the same low-level helpers
//      `generate.mjs` used, and asserting they equal what is on disk. This
//      is a guard against the JSON being hand-edited, or against
//      `generate.mjs` silently becoming non-deterministic - it does not by
//      itself prove `src/` still agrees with the file.
//
//   2. Feeding the vector's frozen output through the REAL verify/decode
//      function in `src/` and asserting it produces the recorded result.
//      THIS is the regression net: if a derivation string, a tag name, an
//      encoding, or a rejection reason changes in `src/`, this fails here,
//      loudly, rather than silently breaking a second implementation that
//      was checked against the old bytes.
//
// The purely deterministic groups (room derivation, join URL, TURN
// credential) have no hidden randomness at all, so they get the strongest
// check: the real `src/` function is called directly on the vector's input
// and must reproduce the recorded output exactly.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { nip44 } from 'nostr-tools'
import { getPublicKey, type Event } from 'nostr-tools/pure'

import { finalizeDeterministic, kindredCanonicalMessage } from './lib/determinism.mjs'
import * as fx from './lib/fixtures.mjs'

import { KINDS } from '../src/kinds.js'
import { deriveRoom, decodeJoinUrl, encodeJoinUrl } from '../src/room.js'
import { verifyDeviceCredential } from '../src/credential.js'
import { decodeRosterEvent } from '../src/roster.js'
import { unwrapSignal } from '../src/signal.js'
import { evaluateAccess } from '../src/access.js'
import { mintTurnCredential } from '../src/turn.js'
import type { RoomPolicy } from '../src/types.js'

interface Vector {
  name: string
  kind: 'positive' | 'negative'
  note: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expected?: any
}

interface VectorDocument {
  protocolVersion: string
  generatedBy: string
  nostrToolsVersion: string
  groups: Record<string, Vector[]>
}

const here = dirname(fileURLToPath(import.meta.url))
const doc = JSON.parse(readFileSync(join(here, 'kithmoot-vectors.json'), 'utf8')) as VectorDocument
const { groups } = doc

function vec(group: string, name: string): Vector {
  const found = groups[group]?.find((v) => v.name === name)
  if (!found) throw new Error(`missing vector ${group}/${name}`)
  return found
}

describe('vector file shape', () => {
  it('carries the protocol version and nostr-tools pin this suite was written against', () => {
    expect(doc.protocolVersion).toBe('kithmoot/v1')
    expect(doc.nostrToolsVersion).toBe('2.23.9')
  })

  it('every group that has a verify/decode/throw path includes at least one negative case', () => {
    for (const group of ['deviceCredential', 'rosterEvent', 'signalWrap', 'accessEvaluation', 'joinUrl']) {
      const negatives = groups[group].filter((v) => v.kind === 'negative')
      expect(negatives.length, `${group} has no negative vectors`).toBeGreaterThan(0)
    }
  })
})

describe('room derivation', () => {
  for (const v of groups.roomDerivation) {
    it(v.name, () => {
      const { roomId, roomKey } = deriveRoom(hexToBytes(v.input.secretHex))
      expect(roomId).toBe(v.output.roomId)
      expect(bytesToHex(roomKey)).toBe(v.output.roomKeyHex)
    })
  }
})

describe('join URL', () => {
  for (const v of groups.joinUrl) {
    it(v.name, () => {
      if (v.kind === 'negative') {
        expect(() => decodeJoinUrl(v.input.url)).toThrow(v.output.error)
        return
      }
      const policy = (v.input.policy ?? undefined) as RoomPolicy | undefined
      const url = encodeJoinUrl(v.input.base, hexToBytes(v.input.secretHex), v.input.relays, policy)
      expect(url).toBe(v.output.url)

      const decoded = decodeJoinUrl(url)
      expect(bytesToHex(decoded.secret)).toBe(v.output.decoded.secretHex)
      expect(decoded.relays).toEqual(v.output.decoded.relays)
      expect(decoded.policy ?? null).toEqual(v.output.decoded.policy)
    })
  }
})

/** Rebuilds a device credential exactly as `generate.mjs` did, from a
 *  vector's own recorded inputs. */
function rebuildCredential(v: Vector): Event {
  return finalizeDeterministic(
    {
      kind: KINDS.CREDENTIAL,
      created_at: v.input.createdAt,
      tags: [
        ['d', v.input.roomId],
        ['device', v.input.devicePubkey],
        ['expiration', String(v.input.expiresAt)],
      ],
      content: '',
    },
    hexToBytes(v.input.participantSkHex),
    hexToBytes(v.input.auxRandHex),
  ) as Event
}

describe('device credential', () => {
  it('valid: reproduces the exact event, and the real implementation accepts it', () => {
    const v = vec('deviceCredential', 'valid')
    expect(rebuildCredential(v)).toEqual(v.output.event)

    const result = verifyDeviceCredential(v.output.event as Event, v.expected.verify)
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual({ ok: true, participant: fx.PARTICIPANT_A, device: fx.DEVICE_A })
  })

  it('wrong-room: the real implementation rejects it', () => {
    const v = vec('deviceCredential', 'wrong-room')
    const result = verifyDeviceCredential(v.input.event as Event, v.input.verify)
    expect(result).toEqual(v.output.result)
    expect(result).toEqual({ ok: false, reason: 'wrong room' })
  })

  it('expired: reproduces the exact event, and the real implementation rejects it', () => {
    const v = vec('deviceCredential', 'expired')
    const event = rebuildCredential(v)
    expect(event).toEqual(v.output.event)
    expect(verifyDeviceCredential(event, v.input.verify)).toEqual(v.output.result)
    expect(v.output.result).toEqual({ ok: false, reason: 'expired' })
  })

  it('tampered-signature: the real implementation rejects it', () => {
    const v = vec('deviceCredential', 'tampered-signature')
    const result = verifyDeviceCredential(v.input.event as Event, v.input.verify)
    expect(result).toEqual(v.output.result)
    expect(result).toEqual({ ok: false, reason: 'bad signature' })
  })
})

/** Rebuilds a roster event exactly as `generate.mjs` did. */
function rebuildRoster(v: Vector): Event {
  const content = nip44.v2.encrypt(JSON.stringify(v.input.entry), hexToBytes(v.input.roomKeyHex), hexToBytes(v.input.nonceHex))
  return finalizeDeterministic(
    { kind: KINDS.ROSTER, created_at: v.input.entry.updatedAt, tags: [['d', v.input.roomId]], content },
    hexToBytes(v.input.deviceSkHex),
    hexToBytes(v.input.auxRandHex),
  ) as Event
}

describe('roster event', () => {
  it('valid: reproduces the exact event, and the real implementation decodes it back to the original entry', () => {
    const v = vec('rosterEvent', 'valid')
    const event = rebuildRoster(v)
    expect(event).toEqual(v.output.event)

    const result = decodeRosterEvent(event, { roomId: v.input.roomId, roomKey: hexToBytes(v.input.roomKeyHex), now: fx.NOW })
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual(v.input.entry)
  })

  it('wrong-room-key: the real implementation returns null rather than throwing', () => {
    const v = vec('rosterEvent', 'wrong-room-key')
    const result = decodeRosterEvent(v.input.event as Event, {
      roomId: v.input.decode.roomId,
      roomKey: hexToBytes(v.input.decode.roomKeyHex),
      now: v.input.decode.now,
    })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('wrong-signing-device: reproduces the exact event, and the real implementation returns null', () => {
    const v = vec('rosterEvent', 'wrong-signing-device')
    const event = rebuildRoster(v)
    expect(event).toEqual(v.output.event)

    const result = decodeRosterEvent(event, { roomId: v.input.roomId, roomKey: hexToBytes(v.input.roomKeyHex), now: fx.NOW })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('tampered-outer-signature: the real implementation returns null rather than throwing', () => {
    const v = vec('rosterEvent', 'tampered-outer-signature')
    const result = decodeRosterEvent(v.input.event as Event, {
      roomId: v.input.decode.roomId,
      roomKey: hexToBytes(v.input.decode.roomKeyHex),
      now: v.input.decode.now,
    })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('forged-credential-signature: reproduces the exact event, and the real implementation returns null', () => {
    const v = vec('rosterEvent', 'forged-credential-signature')
    const event = rebuildRoster(v)
    expect(event).toEqual(v.output.event)

    const result = decodeRosterEvent(event, { roomId: v.input.roomId, roomKey: hexToBytes(v.input.roomKeyHex), now: fx.NOW })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })
})

/** Rebuilds a signal wrap's inner and outer events exactly as `generate.mjs` did. */
function rebuildSignalWrap(v: Vector): { inner: Event; outer: Event } {
  const senderSk = hexToBytes(v.input.senderSkHex)
  const ephemeralSk = hexToBytes(v.input.ephemeralSkHex)

  const inner = finalizeDeterministic(
    { kind: KINDS.SIGNAL, created_at: v.input.createdAt, tags: [['p', v.input.recipientPubkey]], content: JSON.stringify(v.input.body) },
    senderSk,
    hexToBytes(v.input.innerAuxRandHex),
  ) as Event

  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralSk, v.input.recipientPubkey)
  const outerContent = nip44.v2.encrypt(JSON.stringify(inner), conversationKey, hexToBytes(v.input.nip44NonceHex))
  const outer = finalizeDeterministic(
    { kind: KINDS.SIGNAL_WRAP, created_at: v.input.createdAt, tags: [['p', v.input.recipientPubkey]], content: outerContent },
    ephemeralSk,
    hexToBytes(v.input.outerAuxRandHex),
  ) as Event

  return { inner, outer }
}

describe('signal wrap', () => {
  for (const name of ['offer', 'ice-candidate']) {
    it(`${name}: reproduces the exact wrap, and the real implementation unwraps it`, () => {
      const v = vec('signalWrap', name)
      const { inner, outer } = rebuildSignalWrap(v)
      expect(inner).toEqual(v.output.inner)
      expect(outer).toEqual(v.output.outer)

      const result = unwrapSignal(outer, {
        recipientSk: hexToBytes(v.expected.unwrap.recipientSkHex),
        roomId: v.expected.unwrap.roomId,
        // The vectors are stamped with a fixed time, and staleness is
        // deliberately not part of what they pin - see the README. Judging
        // them by the wall clock would make the whole group expire.
        now: v.input.createdAt,
      })
      expect(result).toEqual(v.expected.result)
      expect(result).toEqual({ from: fx.SENDER, body: v.input.body })
    })
  }

  for (const name of ['wrong-recipient', 'wrong-room', 'tampered-inner-signature']) {
    it(`${name}: the real implementation returns null`, () => {
      const v = vec('signalWrap', name)
      const result = unwrapSignal(v.input.wrap as Event, {
        recipientSk: hexToBytes(v.input.unwrap.recipientSkHex),
        roomId: v.input.unwrap.roomId,
        now: (v.input.wrap as Event).created_at,
      })
      expect(result).toBeNull()
      expect(result).toEqual(v.output.result)
    })
  }
})

describe('kindred proof', () => {
  for (const tier of ['ken', 'kith', 'kin']) {
    it(`${tier}: reproduces the exact proof and its signature verifies`, () => {
      const v = vec('kindredProof', tier)
      const message = kindredCanonicalMessage(v.input.tier, v.input.participant, v.input.expiresAt)
      const hostSk = hexToBytes(v.input.hostSkHex)
      const sig = schnorr.sign(message, hostSk, hexToBytes(v.input.auxRandHex))
      const proof = {
        tier: v.input.tier,
        participant: v.input.participant,
        issuer: getPublicKey(hostSk),
        sig: bytesToHex(sig),
        expiresAt: v.input.expiresAt,
      }
      expect(proof).toEqual(v.output.proof)
      expect(schnorr.verify(sig, message, hexToBytes(proof.issuer))).toBe(true)
    })
  }
})

describe('access evaluation', () => {
  for (const v of groups.accessEvaluation) {
    it(`${v.name}: matches the frozen vector`, () => {
      const result = evaluateAccess(v.input.policy, v.input.participant, v.input.proof ?? undefined, v.input.now)
      expect(result).toEqual(v.output.result)
    })
  }
})

describe('TURN credential', () => {
  for (const v of groups.turnCredential) {
    it(v.name, () => {
      const result = v.input.name
        ? mintTurnCredential(v.input.secret, v.input.ttlSeconds, v.input.now, v.input.name)
        : mintTurnCredential(v.input.secret, v.input.ttlSeconds, v.input.now)
      expect(result).toEqual(v.output)
    })
  }
})
