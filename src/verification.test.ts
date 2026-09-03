import { describe, it, expect } from 'vitest'
import { verificationWords, verificationStatus, type KnownParticipant } from './verification.js'

const ROOM_KEY = new Uint8Array(32).fill(7)
const OTHER_ROOM_KEY = new Uint8Array(32).fill(9)

const ADA = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAI = 'c'.repeat(64)

describe('verificationWords', () => {
  it('gives each participant a word', () => {
    const words = verificationWords(ROOM_KEY, ADA, BOB)
    expect(Object.keys(words).sort()).toEqual([ADA, BOB])
    expect(typeof words[ADA]).toBe('string')
    expect(words[ADA]!.length).toBeGreaterThan(0)
  })

  it('gives three words, because one is 11 bits and that is a coin toss', () => {
    // A substituted key would have a 1-in-2048 chance of sounding the same,
    // which somebody would then describe as "verified". Three is ~33 bits.
    const words = verificationWords(ROOM_KEY, ADA, BOB)
    expect(words[ADA]!.split(' ')).toHaveLength(3)
    expect(words[BOB]!.split(' ')).toHaveLength(3)
  })

  it('binds the words to the PAIR, not just to the speaker', () => {
    // The flaw this pins: deriving from the namespace and the speaker's role
    // alone gives a participant the same words against everybody, so they
    // would pass against an impostor standing in for anyone.
    const withBob = verificationWords(ROOM_KEY, ADA, BOB)
    const withCai = verificationWords(ROOM_KEY, ADA, CAI)
    expect(withBob[ADA]).not.toBe(withCai[ADA])
  })

  it('gives the two of them DIFFERENT words', () => {
    // Directional on purpose: if both said the same word, the second speaker
    // could pass by repeating what they just heard.
    const words = verificationWords(ROOM_KEY, ADA, BOB)
    expect(words[ADA]).not.toBe(words[BOB])
  })

  it('derives the same pair whichever order the two are given in', () => {
    // Both clients have to land on the same words without agreeing who goes
    // first, so the roles are the sorted keys.
    expect(verificationWords(ROOM_KEY, ADA, BOB)).toEqual(verificationWords(ROOM_KEY, BOB, ADA))
  })

  it('is stable across calls, so "same as last time" means something', () => {
    expect(verificationWords(ROOM_KEY, ADA, BOB)).toEqual(verificationWords(ROOM_KEY, ADA, BOB))
  })

  it('gives a different pair a different word', () => {
    const ab = verificationWords(ROOM_KEY, ADA, BOB)
    const ac = verificationWords(ROOM_KEY, ADA, CAI)
    expect(ab[ADA]).not.toBe(ac[ADA])
  })

  it('moves when the room key moves, which is what an epoch rekey does', () => {
    const before = verificationWords(ROOM_KEY, ADA, BOB)
    const after = verificationWords(OTHER_ROOM_KEY, ADA, BOB)
    expect(after[ADA]).not.toBe(before[ADA])
  })

  it('accepts keys in upper case and normalises them', () => {
    expect(verificationWords(ROOM_KEY, ADA.toUpperCase(), BOB)).toEqual(verificationWords(ROOM_KEY, ADA, BOB))
  })

  it('refuses a participant verifying against itself', () => {
    // There is no honest word for this, and showing a plausible one would put
    // something on screen that proves nothing.
    expect(() => verificationWords(ROOM_KEY, ADA, ADA)).toThrow(/cannot verify against itself/)
  })

  it('refuses a room key that is not 32 bytes', () => {
    expect(() => verificationWords(new Uint8Array(16), ADA, BOB)).toThrow(/32-byte room key/)
  })

  it('refuses a participant key that is not 64 hex', () => {
    expect(() => verificationWords(ROOM_KEY, 'deadbeef', BOB)).toThrow(/64-hex participant keys/)
  })
})

describe('verificationStatus', () => {
  const known: KnownParticipant[] = [{ participant: ADA, name: 'Ada', verifiedAt: 1_000 }]

  it('is unknown for somebody never seen', () => {
    expect(verificationStatus(known, BOB, 'Bob')).toEqual({ status: 'unknown' })
  })

  it('is unknown with nothing remembered at all', () => {
    expect(verificationStatus([], ADA, 'Ada')).toEqual({ status: 'unknown' })
  })

  it('is verified for a key remembered, and says when', () => {
    expect(verificationStatus(known, ADA, 'Ada')).toEqual({ status: 'verified', verifiedAt: 1_000 })
  })

  it('is verified on the key even if they have renamed themselves', () => {
    // The key is the identity; the name is a label they may change.
    expect(verificationStatus(known, ADA, 'Ada Lovelace').status).toBe('verified')
  })

  it('is key-changed when a familiar name arrives on a different key', () => {
    // The whole point. This is the shape the September incident took.
    const view = verificationStatus(known, BOB, 'Ada')
    expect(view.status).toBe('key-changed')
    expect(view.expected).toBe(ADA)
    expect(view.verifiedAt).toBe(1_000)
  })

  it('matches a name case-insensitively and ignoring surrounding space', () => {
    // An impostor will not reproduce capitalisation exactly, and a false
    // "changed" costs a question while a missed one costs the feature.
    expect(verificationStatus(known, BOB, '  ADA ').status).toBe('key-changed')
  })

  it('names the most recently verified holder when a name has been rotated', () => {
    const rotated: KnownParticipant[] = [
      { participant: ADA, name: 'Ada', verifiedAt: 1_000 },
      { participant: CAI, name: 'Ada', verifiedAt: 5_000 },
    ]
    const view = verificationStatus(rotated, BOB, 'Ada')
    expect(view.expected).toBe(CAI)
    expect(view.verifiedAt).toBe(5_000)
  })

  it('prefers the key match over the name match', () => {
    // Somebody verified under two names is verified, not changed.
    const both: KnownParticipant[] = [
      { participant: ADA, name: 'Ada', verifiedAt: 1_000 },
      { participant: BOB, name: 'Ada', verifiedAt: 5_000 },
    ]
    expect(verificationStatus(both, ADA, 'Ada').status).toBe('verified')
  })

  it('does not accuse on an empty name', () => {
    // Everybody who has not typed a name would otherwise collide with
    // everybody else who has not typed one.
    const anon: KnownParticipant[] = [{ participant: ADA, name: '', verifiedAt: 1_000 }]
    expect(verificationStatus(anon, BOB, '').status).toBe('unknown')
    expect(verificationStatus(anon, BOB, '   ').status).toBe('unknown')
  })

  it('is case-insensitive about the key itself', () => {
    expect(verificationStatus(known, ADA.toUpperCase(), 'Ada').status).toBe('verified')
  })
})
