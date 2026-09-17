import { describe, expect, it } from 'vitest'
import { signerLabel } from './signer-label.js'

describe('signerLabel', () => {
  it('names the signer a saved account last used', () => {
    expect(signerLabel('nip07')).toBe('your Nostr browser extension')
    expect(signerLabel('bunker')).toBe('your bunker')
    expect(signerLabel('amber')).toBe('your Android signer app')
    expect(signerLabel('nsec')).toContain('not kept after a reload')
  })

  it('falls back to generic wording for anything it does not recognise', () => {
    expect(signerLabel(undefined)).toBe('your Nostr signer')
    expect(signerLabel(null)).toBe('your Nostr signer')
    expect(signerLabel('redirect')).toBe('your Nostr signer')
    expect(signerLabel('<b>odd</b>')).toBe('your Nostr signer')
  })
})
