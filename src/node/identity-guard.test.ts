import { describe, it, expect } from 'vitest'
import { nip19 } from 'nostr-tools'
import { resolveKeyRef, checkIdentity, npubOrHex } from './identity-guard.js'

/** Tally's key, and its owner's. The pair from the incident this guards. */
const AGENT = '59742546d2d9319f130119b6d9e74b3a57d2d61ccb02dac937fbf49562b52493'
const PRINCIPAL = 'da19f1cd34beca44be74da4b306d9d1dd86b6343cef94ce22c49c6f59816e5bd'
const AGENT_NPUB = nip19.npubEncode(AGENT)
const PRINCIPAL_NPUB = nip19.npubEncode(PRINCIPAL)

describe('resolveKeyRef', () => {
  it('passes hex through as lowercase', () => {
    expect(resolveKeyRef(AGENT)).toBe(AGENT)
    expect(resolveKeyRef(AGENT.toUpperCase())).toBe(AGENT)
  })

  it('decodes an npub', () => {
    expect(resolveKeyRef(AGENT_NPUB)).toBe(AGENT)
  })

  it('trims surrounding whitespace, which a config file will have', () => {
    expect(resolveKeyRef(`  ${AGENT_NPUB}\n`)).toBe(AGENT)
  })

  it('names the offending value rather than failing vaguely', () => {
    expect(() => resolveKeyRef('deadbeef', '--expect-pubkey')).toThrow(
      /--expect-pubkey "deadbeef" is neither an npub nor 64 hex/,
    )
  })

  it('refuses an nsec with its own message, and says to treat it as exposed', () => {
    // A plausible slip - they sit next to each other in a config - and the
    // generic message would send somebody hunting a typo instead of a leaked
    // secret that is now in a shell history.
    const nsec = nip19.nsecEncode(new Uint8Array(32).fill(7))
    expect(() => resolveKeyRef(nsec)).toThrow(/looks like an nsec/)
    expect(() => resolveKeyRef(nsec)).toThrow(/exposed/)
  })

  it('refuses another nip19 entity that is not an npub', () => {
    const note = nip19.noteEncode(AGENT)
    expect(() => resolveKeyRef(note)).toThrow(/is a note, not an npub/)
  })

  it('refuses an npub that does not decode', () => {
    expect(() => resolveKeyRef('npub1qqqqqqqqqq')).toThrow(/not a decodable npub/)
  })

  it('reads hex before bech32, so a hex key of bech32-legal letters still works', () => {
    // "deadface1ccc..." satisfies a bech32-shaped pattern. Testing that
    // first would reject a perfectly good pubkey as an undecodable npub.
    const hexy = 'deadface1' + 'c'.repeat(55)
    expect(hexy).toHaveLength(64)
    expect(resolveKeyRef(hexy)).toBe(hexy)
  })

  it('refuses empty', () => {
    expect(() => resolveKeyRef('', 'key')).toThrow(/is empty/)
    expect(() => resolveKeyRef('   ', 'key')).toThrow(/is empty/)
  })
})

describe('checkIdentity', () => {
  it('allows a key with nothing asserted about it', () => {
    expect(() => checkIdentity({ pubkey: AGENT })).not.toThrow()
  })

  it('allows the expected key, given as hex or npub', () => {
    expect(() => checkIdentity({ pubkey: AGENT, expect: AGENT })).not.toThrow()
    expect(() => checkIdentity({ pubkey: AGENT, expect: AGENT_NPUB })).not.toThrow()
  })

  it('refuses a key that is not the expected one, naming both', () => {
    let message = ''
    try {
      checkIdentity({ pubkey: PRINCIPAL, expect: AGENT_NPUB })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain(AGENT_NPUB)
    expect(message).toContain(PRINCIPAL_NPUB)
  })

  it('points at the create-if-missing behaviour, which is how this usually happens', () => {
    expect(() => checkIdentity({ pubkey: PRINCIPAL, expect: AGENT })).toThrow(/created with a FRESH key/)
  })

  it('refuses a forbidden key', () => {
    expect(() => checkIdentity({ pubkey: PRINCIPAL, forbid: [PRINCIPAL_NPUB] })).toThrow(/forbidden list/)
  })

  it('explains why a principal key on an agent is not merely untidy', () => {
    // The reason the rule exists: same key means the agent is the principal
    // those checks look for, so it can attest to itself and approve itself.
    expect(() => checkIdentity({ pubkey: PRINCIPAL, forbid: [PRINCIPAL] })).toThrow(/approve its own requests/)
  })

  it('checks every entry on the forbidden list, not just the first', () => {
    expect(() =>
      checkIdentity({ pubkey: PRINCIPAL, forbid: [AGENT, '11'.repeat(32), PRINCIPAL] }),
    ).toThrow(/forbidden list/)
  })

  it('allows a key that is on no forbidden entry', () => {
    expect(() => checkIdentity({ pubkey: AGENT, forbid: [PRINCIPAL, '11'.repeat(32)] })).not.toThrow()
  })

  it('reports the forbidden key before the wrong-key complaint', () => {
    // Both are true here. Being a principal is the more alarming answer and
    // is the one an operator needs first.
    expect(() => checkIdentity({ pubkey: PRINCIPAL, expect: AGENT, forbid: [PRINCIPAL] })).toThrow(
      /forbidden list/,
    )
  })

  it('is case-insensitive about the key it was handed', () => {
    expect(() => checkIdentity({ pubkey: AGENT.toUpperCase(), expect: AGENT })).not.toThrow()
    expect(() => checkIdentity({ pubkey: PRINCIPAL.toUpperCase(), forbid: [PRINCIPAL] })).toThrow(
      /forbidden list/,
    )
  })

  it('rejects a malformed assertion rather than ignoring it', () => {
    // A --forbid-pubkey nobody can parse must not silently allow everything.
    expect(() => checkIdentity({ pubkey: AGENT, forbid: ['not-a-key'] })).toThrow(/--forbid-pubkey/)
    expect(() => checkIdentity({ pubkey: AGENT, expect: 'not-a-key' })).toThrow(/--expect-pubkey/)
  })

  it('the incident: an agent handed its owner principal key is stopped', () => {
    // Tally's own key is fine; the principal's is not, whatever else is set.
    expect(() => checkIdentity({ pubkey: AGENT, forbid: [PRINCIPAL] })).not.toThrow()
    expect(() => checkIdentity({ pubkey: PRINCIPAL, forbid: [PRINCIPAL] })).toThrow()
  })
})

describe('npubOrHex', () => {
  it('encodes a good key', () => {
    expect(npubOrHex(AGENT)).toBe(AGENT_NPUB)
  })

  it('hands back whatever it was given rather than throwing', () => {
    // A startup banner must never be the thing that takes a process down.
    expect(npubOrHex('nonsense')).toBe('nonsense')
    expect(npubOrHex('')).toBe('')
  })
})
