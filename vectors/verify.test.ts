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
import { deriveChannel } from '../src/chat.js'
import { verifyDeviceCredential } from '../src/credential.js'
import { decodeRosterEvent } from '../src/roster.js'
import { sanitiseAssistOffer } from '../src/peer-assist.js'
import { sanitiseDisplayName, MAX_DISPLAY_NAME_LENGTH } from '../src/display-name.js'
import { unwrapSignal } from '../src/signal.js'
import { evaluateAccess, issueKindredProof } from '../src/access.js'
import { mintTurnCredential } from '../src/turn.js'
import { decodeDescriptorEvent } from '../src/descriptor.js'
import { deriveEpoch, peekRekeyEvent, decodeRekeyEvent, signAdmins, verifyAdmins, canonicalAdmins } from '../src/epoch.js'
import { normaliseAgentOwnership, verifyAgentOwnership } from '../src/ownership.js'
import { decodeChatEvent } from '../src/chat.js'
import { deriveEnvelopeKey, paddedPlaintextLength, buildFileEvent, buildUploadAuthorisation } from '../src/attachment.js'
import { encodeControl, decodeControl } from '../src/control.js'
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
    for (const group of ['deviceCredential', 'rosterEvent', 'signalWrap', 'accessEvaluation', 'joinUrl', 'roomDescriptor', 'roomEpoch', 'agentOwnership', 'chatAttachment', 'approvalControl']) {
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

describe('channel derivation', () => {
  for (const v of groups.channelDerivation) {
    it(v.name, () => {
      const { id, key } = deriveChannel(v.input.roomId, hexToBytes(v.input.roomKeyHex), v.input.channel)
      expect(id).toBe(v.output.id)
      expect(bytesToHex(key)).toBe(v.output.keyHex)
      if (v.input.channel === undefined) {
        expect(id).toBe(v.input.roomId)
        expect(bytesToHex(key)).toBe(v.input.roomKeyHex)
      } else {
        expect(id).not.toBe(v.input.roomId)
        expect(bytesToHex(key)).not.toBe(v.input.roomKeyHex)
      }
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

  it('display-name: the name survives the round trip and decides nothing', () => {
    const v = vec('rosterEvent', 'display-name')
    const result = decodeRosterEvent(v.input.event as Event, {
      roomId: v.expected.decode.roomId,
      roomKey: hexToBytes(v.expected.decode.roomKeyHex),
      now: v.expected.decode.now,
    })
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual(v.output.result)
    expect(result!.name).toBe('Darren')
    // A name is a label on a pubkey, never a substitute for one.
    expect(result!.participant).toBe(fx.PARTICIPANT_A)
    expect(result!.device).toBe(fx.DEVICE_A)
    // And it stays inside the ciphertext, where the participant pubkey is.
    expect(JSON.stringify(v.input.event)).not.toContain('Darren')
  })

  it('display-name-hostile: the entry is accepted and only the name is defused', () => {
    const v = vec('rosterEvent', 'display-name-hostile')
    const result = decodeRosterEvent(v.input.event as Event, {
      roomId: v.expected.decode.roomId,
      roomKey: hexToBytes(v.expected.decode.roomKeyHex),
      now: v.expected.decode.now,
    })
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual(v.output.result)
    // The person and their credential are genuine; the name was the only
    // thing at fault, so the name is the only thing changed.
    expect(result!.participant).toBe(fx.PARTICIPANT_A)
    expect(result!.name).not.toBe(v.input.rawName)
    expect(result!.name).toBe(sanitiseDisplayName(v.input.rawName))
    expect(result!.name).not.toMatch(/\p{C}/u)
    expect([...result!.name!]).toHaveLength(MAX_DISPLAY_NAME_LENGTH)
  })

  it('agent: decodes with the flag kept, inside the ciphertext', () => {
    const v = vec('rosterEvent', 'agent')
    const result = decodeRosterEvent(v.input.event as Event, {
      roomId: v.expected.decode.roomId,
      roomKey: hexToBytes(v.expected.decode.roomKeyHex),
      now: v.expected.decode.now,
    })
    expect(result).toEqual(v.expected.result)
    expect(result!.agent).toBe(true)
    expect(JSON.stringify(v.input.event)).not.toContain('agent')
  })

  it('agent-loose-value: accepts the entry and drops the flag', () => {
    const v = vec('rosterEvent', 'agent-loose-value')
    const result = decodeRosterEvent(v.input.event as Event, {
      roomId: v.expected.decode.roomId,
      roomKey: hexToBytes(v.expected.decode.roomKeyHex),
      now: v.expected.decode.now,
    })
    expect(result).toEqual(v.expected.result)
    expect(result).not.toBeNull()
    expect(result).not.toHaveProperty('agent')
  })

  it('farewell: decodes to a departure, and the field is inside the ciphertext', () => {
    const v = vec('rosterEvent', 'farewell')
    const result = decodeRosterEvent(v.input.event as Event, {
      roomId: v.expected.decode.roomId,
      roomKey: hexToBytes(v.expected.decode.roomKeyHex),
      now: v.expected.decode.now,
    })
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual(v.output.result)
    expect(result!.left).toBe(true)
    expect(result!.reply).toBe(true)
    expect(result!.tracks).toEqual([])
    expect(result!.claims).toEqual({})
    // A relay that could see who was leaving would be watching the room's
    // door; the flag rides inside the room-key ciphertext like everything.
    expect(JSON.stringify(v.input.event)).not.toContain('left')
  })

  it('assist-offer: the offer survives the round trip and stays inside the ciphertext', () => {
    const v = vec('rosterEvent', 'assist-offer')
    const result = decodeRosterEvent(v.input.event as Event, {
      roomId: v.expected.decode.roomId,
      roomKey: hexToBytes(v.expected.decode.roomKeyHex),
      now: v.expected.decode.now,
    })
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual(v.output.result)
    expect(result!.assist).toEqual(sanitiseAssistOffer(result!.assist))
    expect(result!.assist!.reachability).toBe('public')
    // A relay that could read which members were publicly reachable, and how
    // much uplink they had, would be reading a map of the room.
    expect(JSON.stringify(v.input.event)).not.toContain('uplinkBps')
    expect(JSON.stringify(v.input.event)).not.toContain('public')
  })

  it('assist-offer-hostile: the entry is accepted and the offer is dropped whole', () => {
    const v = vec('rosterEvent', 'assist-offer-hostile')
    const result = decodeRosterEvent(v.input.event as Event, {
      roomId: v.expected.decode.roomId,
      roomKey: hexToBytes(v.expected.decode.roomKeyHex),
      now: v.expected.decode.now,
    })
    expect(result).toEqual(v.expected.result)
    expect(result).toEqual(v.output.result)
    // The person is genuinely here and their credential is genuine.
    expect(result!.participant).toBe(fx.PARTICIPANT_A)
    // Dropped, not repaired. A mended number is still one the publisher
    // chose, and it would go on to decide who carries this room.
    expect(result!.assist).toBeUndefined()
    expect(sanitiseAssistOffer(v.input.rawAssist)).toBeUndefined()
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
      const message = kindredCanonicalMessage(
        v.input.tier,
        v.input.participant,
        v.input.roomId,
        v.input.nonce,
        v.input.expiresAt,
      )
      const hostSk = hexToBytes(v.input.hostSkHex)
      const sig = schnorr.sign(message, hostSk, hexToBytes(v.input.auxRandHex))
      const proof = {
        tier: v.input.tier,
        participant: v.input.participant,
        issuer: getPublicKey(hostSk),
        room: v.input.roomId,
        nonce: v.input.nonce,
        sig: bytesToHex(sig),
        expiresAt: v.input.expiresAt,
      }
      expect(proof).toEqual(v.output.proof)
      expect(schnorr.verify(sig, message, hexToBytes(proof.issuer))).toBe(true)

      // And the real implementation, given the same fixed nonce, produces
      // exactly the same proof - so the vector pins `issueKindredProof`, not
      // just a message layout the test happens to agree with.
      expect(
        issueKindredProof({
          hostSk,
          participant: v.input.participant,
          tier: v.input.tier,
          roomId: v.input.roomId,
          nonce: v.input.nonce,
          expiresAt: v.input.expiresAt,
        }),
      ).toMatchObject({
        tier: proof.tier,
        participant: proof.participant,
        issuer: proof.issuer,
        room: proof.room,
        nonce: proof.nonce,
        expiresAt: proof.expiresAt,
      })
    })
  }
})

describe('access evaluation', () => {
  for (const v of groups.accessEvaluation) {
    it(`${v.name}: matches the frozen vector`, () => {
      const result = evaluateAccess(
        v.input.policy,
        v.input.participant,
        v.input.proof ?? undefined,
        v.input.now,
        v.input.roomId,
      )
      expect(result).toEqual(v.output.result)
    })
  }
})

/** Rebuilds a room descriptor event exactly as `generate.mjs` did. */
function rebuildDescriptor(v: Vector): Event {
  const content = nip44.v2.encrypt(
    JSON.stringify(v.input.descriptor),
    hexToBytes(v.input.roomKeyHex),
    hexToBytes(v.input.nonceHex),
  )
  return finalizeDeterministic(
    { kind: KINDS.DESCRIPTOR, created_at: v.input.descriptor.updatedAt, tags: [['d', v.input.roomId]], content },
    hexToBytes(v.input.deviceSkHex),
    hexToBytes(v.input.auxRandHex),
  ) as Event
}

describe('room descriptor', () => {
  for (const name of ['no-forwarders', 'one-forwarder', 'several-forwarders']) {
    it(`${name}: reproduces the exact event, and the real implementation decodes it back`, () => {
      const v = vec('roomDescriptor', name)
      const event = rebuildDescriptor(v)
      expect(event).toEqual(v.output.event)

      const result = decodeDescriptorEvent(event, {
        roomId: v.input.roomId,
        roomKey: hexToBytes(v.input.roomKeyHex),
        now: v.expected.decode.now,
      })
      expect(result).toEqual(v.expected.result)
      expect(result!.forwarders).toEqual(v.input.descriptor.forwarders)
    })
  }

  it('forwarder-extra-fields-stripped: a forwarder entry never carries the room key out of a decode', () => {
    const v = vec('roomDescriptor', 'forwarder-extra-fields-stripped')
    const event = rebuildDescriptor(v)
    expect(event).toEqual(v.output.event)

    const result = decodeDescriptorEvent(event, {
      roomId: v.input.roomId,
      roomKey: hexToBytes(v.input.roomKeyHex),
      now: v.expected.decode.now,
    })
    expect(result).toEqual(v.expected.result)

    // The plaintext really did carry the room key - this is not a vector
    // that would pass on an implementation that simply never had one to leak.
    expect(JSON.stringify(v.input.descriptor)).toContain(v.input.roomKeyHex)
    // And it is gone, along with every other field a forwarder reference is
    // not allowed to have.
    expect(JSON.stringify(result!.forwarders)).not.toContain(v.input.roomKeyHex)
    expect(Object.keys(result!.forwarders[0]).sort()).toEqual(['label', 'pubkey', 'url'])
  })

  it('wrong-room-key: the real implementation returns null rather than throwing', () => {
    const v = vec('roomDescriptor', 'wrong-room-key')
    const result = decodeDescriptorEvent(v.input.event as Event, {
      roomId: v.input.decode.roomId,
      roomKey: hexToBytes(v.input.decode.roomKeyHex),
      now: v.input.decode.now,
    })
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result)
  })

  it('wrong-signing-device: reproduces the exact event, and the real implementation returns null', () => {
    const v = vec('roomDescriptor', 'wrong-signing-device')
    const event = rebuildDescriptor(v)
    expect(event).toEqual(v.output.event)
    expect(
      decodeDescriptorEvent(event, {
        roomId: v.input.roomId,
        roomKey: hexToBytes(v.input.roomKeyHex),
        now: fx.NOW,
      }),
    ).toBeNull()
  })
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

describe('room epoch', () => {
  for (const v of groups.roomEpoch.filter((x) => x.name.startsWith('epoch-'))) {
    it(v.name, () => {
      const keys = deriveEpoch({ epoch: v.input.epoch as number, secret: hexToBytes(v.input.secretHex as string) })
      expect(keys.epoch).toBe(v.output.epoch)
      expect(keys.id).toBe(v.output.id)
      expect(bytesToHex(keys.key)).toBe(v.output.keyHex)
      // Epoch 0 is the room itself, byte for byte: it is what makes every
      // other group in this file the same room before anybody is removed.
      if (v.input.epoch === 0) {
        const room = deriveRoom(hexToBytes(v.input.secretHex as string))
        expect(keys.id).toBe(room.roomId)
        expect(bytesToHex(keys.key)).toBe(bytesToHex(room.roomKey))
      }
    })
  }

  /** The decode arguments a rekey vector names, as the real function wants them. */
  function rekeyArgs(decode: Record<string, unknown>) {
    return {
      roomId: decode.roomId as string,
      authority: decode.authority as string,
      current: {
        epoch: (decode.current as Record<string, unknown>).epoch as number,
        id: (decode.current as Record<string, unknown>).id as string,
        key: hexToBytes((decode.current as Record<string, unknown>).keyHex as string),
      },
      deviceSk: hexToBytes(decode.deviceSkHex as string),
    }
  }

  /** A notice as the vector records it: bytes do not survive JSON, so the
   *  successor secret is written as hex and compared as hex. */
  function noticeJson(notice: ReturnType<typeof decodeRekeyEvent>) {
    if (notice === null) return null
    const { secret, ...rest } = notice
    return { ...rest, ...(secret ? { secretHex: bytesToHex(secret) } : {}) }
  }

  it('rekey: the kept device reads the notice and gets the successor secret', () => {
    const v = vec('roomEpoch', 'rekey')
    const args = rekeyArgs(v.expected!.decode as Record<string, unknown>)
    expect(peekRekeyEvent(v.input.event as Event, { roomId: args.roomId, authority: args.authority })).toBe(v.output.peek)
    const result = decodeRekeyEvent(v.input.event as Event, args)
    expect(noticeJson(result)).toEqual(v.expected!.result)
    expect(result!.epoch).toBe(1)
    expect(result!.removed).toEqual([fx.REMOVED_DEVICE])
    expect(result!.secret).toBeDefined()
    // The successor secret derives the epoch the room is moving to, which is
    // the whole point of the sealed copy.
    expect(deriveEpoch({ epoch: 1, secret: result!.secret! }).id).toBe(deriveEpoch({ epoch: 1, secret: fx.EPOCH_SECRET_1 }).id)
    // And it is sealed: the ciphertext carries no secret in the clear.
    expect(JSON.stringify(v.input.event)).not.toContain(bytesToHex(fx.EPOCH_SECRET_1))
  })

  it('rekey: the removed device reads the notice and gets no secret', () => {
    const v = vec('roomEpoch', 'rekey-read-by-the-removed-device')
    const result = decodeRekeyEvent(v.input.event as Event, rekeyArgs(v.expected!.decode as Record<string, unknown>))
    expect(noticeJson(result)).toEqual(v.expected!.result)
    expect(result!.secret).toBeUndefined()
    expect(result!.removed).toContain(fx.REMOVED_DEVICE)
  })

  it('rekey-closed: the epoch advances and nobody is given it', () => {
    const v = vec('roomEpoch', 'rekey-closed')
    const result = decodeRekeyEvent(v.input.event as Event, rekeyArgs(v.expected!.decode as Record<string, unknown>))
    expect(noticeJson(result)).toEqual(v.expected!.result)
    expect(result!.closed).toBe(true)
    expect(result!.secret).toBeUndefined()
  })

  for (const name of ['rekey-not-the-authority', 'rekey-skips-an-epoch']) {
    it(`${name}: refused`, () => {
      const v = vec('roomEpoch', name)
      const result = decodeRekeyEvent(v.input.event as Event, rekeyArgs(v.input.decode as Record<string, unknown>))
      expect(result).toBeNull()
      expect(result).toEqual(v.output.result ?? null)
    })
  }

  it('admins-signature: canonical, and bound to its epoch', () => {
    const v = vec('roomEpoch', 'admins-signature')
    const admins = v.input.admins as string[]
    const roomId = v.input.roomId as string
    const epoch = v.input.epoch as number
    expect(canonicalAdmins(admins)).toEqual(v.output.canonical)
    // The recorded signature is checked rather than re-made: `signAdmins`
    // signs with random aux-rand, so an implementation that produces a
    // different signature for the same list is correct, and one that will
    // not accept this one is not.
    expect(verifyAdmins({ roomId, epoch, admins, sig: v.output.sig as string, authority: fx.AUTHORITY })).toBe(true)
    // The order a client happens to hold them in changes nothing.
    expect(
      verifyAdmins({ roomId, epoch, admins: [...admins].reverse(), sig: v.output.sig as string, authority: fx.AUTHORITY }),
    ).toBe(true)
    // And this implementation's own signature verifies too.
    const mine = signAdmins({ roomId, epoch, admins, authoritySk: hexToBytes(v.input.authoritySkHex as string) })
    expect(verifyAdmins({ roomId, epoch, admins, sig: mine, authority: fx.AUTHORITY })).toBe(true)
  })

  it('admins-signature-another-epoch: refused', () => {
    const v = vec('roomEpoch', 'admins-signature-another-epoch')
    expect(
      verifyAdmins({
        roomId: v.input.roomId as string,
        epoch: v.input.epoch as number,
        admins: v.input.admins as string[],
        sig: v.input.sig as string,
        authority: v.input.authority as string,
      }),
    ).toBe(false)
  })
})

describe('agent ownership', () => {
  for (const name of ['valid', 'with-expiry-and-label']) {
    it(name, () => {
      const v = vec('agentOwnership', name)
      const proof = v.output.proof as Record<string, unknown>
      const result = verifyAgentOwnership(proof, {
        agent: (v.expected!.verify as Record<string, unknown>).agent as string,
        now: (v.expected!.verify as Record<string, unknown>).now as number,
      })
      expect(result).toEqual(v.expected!.result)
      expect(result.ok).toBe(true)
      // Room independent by design: nothing in the proof names a room.
      expect(JSON.stringify(proof)).not.toContain(deriveRoom(fx.ROOM_SECRET_1).roomId)
    })
  }

  for (const name of ['names-another-agent', 'expired', 'label-not-as-signed', 'its-own-principal', 'bad-signature']) {
    it(`${name}: refused, with a reason`, () => {
      const v = vec('agentOwnership', name)
      const verify = v.input.verify as Record<string, unknown>
      const result = verifyAgentOwnership(v.input.proof, { agent: verify.agent as string, now: verify.now as number })
      expect(result).toEqual(v.output.result)
      expect(result.ok).toBe(false)
    })
  }

  it('normalised-shape: keys lower-cased, unknown fields dropped, order fixed', () => {
    const v = vec('agentOwnership', 'normalised-shape')
    const result = normaliseAgentOwnership(v.input.raw)
    expect(result).toEqual(v.output.result)
    // The order is what the roster and chat encoders re-serialise, so it is
    // part of the wire format rather than a detail.
    expect(Object.keys(result!)).toEqual(Object.keys(v.output.result as object))
  })
})

describe('chat attachment', () => {
  function chatArgs(decode: Record<string, unknown>) {
    return { roomId: decode.roomId as string, roomKey: hexToBytes(decode.roomKeyHex as string), now: decode.now as number }
  }

  it('chat-with-attachment: everything that matters is inside the ciphertext', () => {
    const v = vec('chatAttachment', 'chat-with-attachment')
    const result = decodeChatEvent(v.input.event as Event, chatArgs(v.expected!.decode as Record<string, unknown>))
    expect(result).toEqual(v.expected!.result)
    expect(result!.attachments).toHaveLength(1)
    const wire = JSON.stringify(v.input.event)
    for (const secret of [fx.ATTACHMENT_KEY, fx.ATTACHMENT_URL, fx.ATTACHMENT_SHA256]) {
      expect(wire).not.toContain(secret)
    }
  })

  it('attachments-a-reader-must-defuse: the message survives, the bad shares do not', () => {
    const v = vec('chatAttachment', 'attachments-a-reader-must-defuse')
    const result = decodeChatEvent(v.input.event as Event, chatArgs(v.expected!.decode as Record<string, unknown>))
    expect(result).toEqual(v.expected!.result)
    expect(result!.text).toBe('two of these are not shares')
    expect(result!.attachments).toHaveLength(1)
    expect(result!.attachments![0]!.url.startsWith('https:')).toBe(true)
    expect(result!.attachments![0]!.type).toBe('application/pdf')
    expect(result!.attachments![0]!.name).not.toContain('‮')
    expect(result!.attachments![0]!.size).toBeUndefined()
  })

  it('more-attachments-than-a-message-may-carry: the whole message is refused', () => {
    const v = vec('chatAttachment', 'more-attachments-than-a-message-may-carry')
    const result = decodeChatEvent(v.input.event as Event, chatArgs(v.input.decode as Record<string, unknown>))
    expect(result).toBeNull()
    expect(result).toEqual(v.output.result ?? null)
  })

  it('envelope-key-derivation', () => {
    const v = vec('chatAttachment', 'envelope-key-derivation')
    expect(bytesToHex(deriveEnvelopeKey(hexToBytes(v.input.recoveryKeyHex as string), hexToBytes(v.input.saltHex as string)))).toBe(
      v.output.keyHex,
    )
  })

  it('padded-plaintext-length', () => {
    const v = vec('chatAttachment', 'padded-plaintext-length')
    expect((v.input.lengths as number[]).map(paddedPlaintextLength)).toEqual(v.output.padded)
  })

  it('file-event', () => {
    const v = vec('chatAttachment', 'file-event')
    expect(
      buildFileEvent(
        { url: v.input.url as string, sha256: v.input.sha256 as string, size: v.input.size as number },
        v.input.now as number,
      ),
    ).toEqual(v.output.template)
  })

  it('upload-authorisation', () => {
    const v = vec('chatAttachment', 'upload-authorisation')
    expect(buildUploadAuthorisation(v.input.sha256 as string, v.input.server as string, v.input.now as number)).toEqual(
      v.output.template,
    )
  })
})

describe('approval control', () => {
  for (const v of groups.approvalControl.filter((x) => x.kind === 'positive')) {
    it(v.name, () => {
      const text = encodeControl(v.input.message as never)
      expect(text).toBe(v.output.text)
      expect(decodeControl(text)).toEqual(v.output.result)
    })
  }

  for (const v of groups.approvalControl.filter((x) => x.kind === 'negative')) {
    it(`${v.name}: not a control message`, () => {
      const result = decodeControl(v.input.text as string)
      expect(result).toBeNull()
      expect(result).toEqual(v.output.result ?? null)
    })
  }

  it('an admin list is believed on the authority signature, not on who sent it', () => {
    const v = vec('approvalControl', 'admins-announcement')
    const message = decodeControl(v.output.text as string)!
    expect(message.op).toBe('admins')
    const admins = (message as { admins: string[] }).admins
    expect(
      verifyAdmins({
        roomId: v.input.roomId as string,
        epoch: (message as { epoch: number }).epoch,
        admins,
        sig: (message as { sig: string }).sig,
        authority: v.input.authority as string,
      }),
    ).toBe(true)
    // The same list, offered under anybody else's authority, is not believed.
    expect(
      verifyAdmins({
        roomId: v.input.roomId as string,
        epoch: (message as { epoch: number }).epoch,
        admins,
        sig: (message as { sig: string }).sig,
        authority: fx.HOST_UNTRUSTED,
      }),
    ).toBe(false)
  })
})
