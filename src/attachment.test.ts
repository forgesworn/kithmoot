import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import {
  decryptEnvelope,
  deriveEnvelopeKey,
  fetchAttachment,
  formatRecoveryKey,
  parseRecoveryKey,
  paddedPlaintextLength,
  canonicalEnvelopeName,
  sha256Hex,
  verifyEnvelopeHash,
} from './attachment.js'
import type { ChatAttachment } from './chat.js'

// Wildbloom's published known-answer vectors, copied verbatim. The two
// FSWNENC2 vectors carry the envelope bytes; the FSWNENC1 and legacy ones
// carry a recipe (deterministic padding, key, nonce prefix) and the hash the
// envelope must come out to, so the test builds the envelope itself and
// proves the recipe against the published hash before decrypting it.
function vector(name: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(`../test/fixtures/wildbloom/${name}.json`, import.meta.url), 'utf8'))
}

const CHUNK = 1024 * 1024

interface RecipeVector {
  headerHex: string
  testOnlyKey: { rawHex: string; recoveryKey: string }
  noncePrefixHex: string
  padding: { plaintextBytes: number }
  metadata: { canonicalUtf8: string }
  source: { name: string; type: string; bytes: number; utf8?: string; formula?: string; sha256: string }
  envelopeBytes: number
  envelopeSha256: string
  authenticationTagHex?: string
  records?: Array<{ authenticationTagHex: string }>
}

function sourceOf(v: RecipeVector): Uint8Array {
  if (v.source.utf8 !== undefined) return new TextEncoder().encode(v.source.utf8)
  // "byte[i] = (i * 29 + 7) mod 256"
  const out = new Uint8Array(v.source.bytes)
  for (let i = 0; i < out.length; i += 1) out[i] = (i * 29 + 7) % 256
  return out
}

/** Seal a vector's source exactly as its recipe says, with an independent
 *  AES-GCM, and hand back the envelope. */
function sealRecipe(v: RecipeVector): { envelope: Uint8Array; source: Uint8Array } {
  const header = hexToBytes(v.headerHex)
  const key = hexToBytes(v.testOnlyKey.rawHex)
  const noncePrefix = hexToBytes(v.noncePrefixHex)
  const metadata = new TextEncoder().encode(v.metadata.canonicalUtf8)
  const source = sourceOf(v)
  const plaintext = new Uint8Array(v.padding.plaintextBytes)
  for (let i = 0; i < plaintext.length; i += 1) plaintext[i] = (i * 73 + 41) % 256
  new DataView(plaintext.buffer).setUint32(0, metadata.length, false)
  plaintext.set(metadata, 4)
  plaintext.set(source, 4 + metadata.length)
  const records = Math.ceil(plaintext.length / CHUNK)
  const parts: Uint8Array[] = [header]
  for (let counter = 0; counter < records; counter += 1) {
    const nonce = new Uint8Array(12)
    nonce.set(noncePrefix)
    new DataView(nonce.buffer).setUint32(8, counter, false)
    const aad = new Uint8Array(header.length + 4)
    aad.set(header)
    new DataView(aad.buffer).setUint32(header.length, counter, false)
    parts.push(gcm(key, nonce, aad).encrypt(plaintext.subarray(counter * CHUNK, (counter + 1) * CHUNK)))
  }
  const envelope = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    envelope.set(p, offset)
    offset += p.length
  }
  return { envelope, source }
}

function v2Envelope(name: string): { envelope: Uint8Array; v: Record<string, any> } {
  const v = vector(name)
  return { envelope: new Uint8Array(Buffer.from(v.envelopeBase64, 'base64')), v }
}

describe('FSWNENC2 known-answer vectors', () => {
  for (const name of ['fswnenc2-per-file', 'fswnenc2-vault']) {
    it(`opens ${name}`, () => {
      const { envelope, v } = v2Envelope(name)
      expect(envelope.length).toBe(v.envelopeBytes)
      expect(sha256Hex(envelope)).toBe(v.envelopeSha256)
      expect(bytesToHex(envelope.subarray(0, 56))).toBe(v.headerHex)
      // The derived key is published, so the derivation is checked on its
      // own and not only through the tag it produces.
      expect(bytesToHex(deriveEnvelopeKey(hexToBytes(v.testOnlyInputKeyHex), hexToBytes(v.saltHex)))).toBe(
        v.testOnlyDerivedKeyHex,
      )
      const opened = decryptEnvelope(envelope, v.testOnlyInputKeyHex)
      expect(opened.name).toBe(v.source.name)
      expect(opened.type).toBe(v.source.type)
      expect(opened.size).toBe(v.source.bytes)
      expect(new TextDecoder().decode(opened.source)).toBe(v.source.utf8)
      expect(sha256Hex(opened.source)).toBe(v.source.sha256)
    })
  }

  it('the two modes differ only in the input key, and neither opens the other', () => {
    const perFile = v2Envelope('fswnenc2-per-file')
    const vault = v2Envelope('fswnenc2-vault')
    expect(() => decryptEnvelope(perFile.envelope, vault.v.testOnlyInputKeyHex)).toThrow(/wrong or/)
    expect(() => decryptEnvelope(vault.envelope, perFile.v.testOnlyInputKeyHex)).toThrow(/wrong or/)
  })
})

describe('FSWNENC1 and legacy WBLMENC1 known-answer vectors', () => {
  for (const name of ['encryption-v2', 'encryption-v1', 'encryption-v2-two-records', 'encryption-v1-two-records']) {
    it(`seals ${name} to the published hash and opens it again`, () => {
      const v = vector(name) as RecipeVector
      const { envelope, source } = sealRecipe(v)
      expect(envelope.length).toBe(v.envelopeBytes)
      // The recipe reproduces Wildbloom's bytes exactly, so what is being
      // decrypted below is what Wildbloom would have uploaded.
      expect(sha256Hex(envelope)).toBe(v.envelopeSha256)
      const tags = v.records ? v.records.map((r) => r.authenticationTagHex) : [v.authenticationTagHex!]
      tags.forEach((tag, i) => {
        const end = i === tags.length - 1 ? envelope.length : 24 + (i + 1) * (CHUNK + 16)
        expect(bytesToHex(envelope.subarray(end - 16, end))).toBe(tag)
      })
      const opened = decryptEnvelope(envelope, v.testOnlyKey.rawHex)
      expect(opened.name).toBe(v.source.name)
      expect(opened.type).toBe(v.source.type)
      expect(opened.size).toBe(v.source.bytes)
      expect(sha256Hex(opened.source)).toBe(v.source.sha256)
      expect(opened.source).toEqual(source)
      // And the key Wildbloom shows its user is the key the chat carries.
      expect(parseRecoveryKey(v.testOnlyKey.recoveryKey)).toBe(v.testOnlyKey.rawHex)
      expect(formatRecoveryKey(v.testOnlyKey.rawHex)).toBe(v.testOnlyKey.recoveryKey)
    })
  }
})

describe('an envelope that is not exactly right is refused', () => {
  const { envelope, v } = v2Envelope('fswnenc2-per-file')
  const key = v.testOnlyInputKeyHex as string

  it('a flipped byte in the authentication tag', () => {
    const bad = envelope.slice()
    bad[bad.length - 1] ^= 0x01
    expect(() => decryptEnvelope(bad, key)).toThrow(/wrong or the encrypted envelope was modified/)
  })

  it('a flipped byte in the ciphertext', () => {
    const bad = envelope.slice()
    bad[100] ^= 0x80
    expect(() => decryptEnvelope(bad, key)).toThrow(/wrong or/)
  })

  it('a flipped byte in the header, which the tag covers', () => {
    const bad = envelope.slice()
    bad[20] ^= 0x01
    expect(() => decryptEnvelope(bad, key)).toThrow(/wrong or/)
  })

  it('the wrong key, and a key that is not a key', () => {
    expect(() => decryptEnvelope(envelope, '11'.repeat(32))).toThrow(/wrong or/)
    expect(() => decryptEnvelope(envelope, 'not hex')).toThrow(/not a Wildbloom key/)
    expect(() => decryptEnvelope(envelope, key.toUpperCase())).toThrow(/not a Wildbloom key/)
  })

  it('a truncated envelope, cut inside a record and cut below the minimum', () => {
    expect(() => decryptEnvelope(envelope.subarray(0, envelope.length - 100), key)).toThrow(/wrong or/)
    expect(() => decryptEnvelope(envelope.subarray(0, 56 + 16), key)).toThrow(/length is invalid/)
    expect(() => decryptEnvelope(envelope.subarray(0, 40), key)).toThrow(/not a Wildbloom encrypted envelope/)
    expect(() => decryptEnvelope(new Uint8Array(0), key)).toThrow(/not a Wildbloom encrypted envelope/)
  })

  it('an over-long envelope', () => {
    const long = new Uint8Array(envelope.length + 1)
    long.set(envelope)
    expect(() => decryptEnvelope(long, key)).toThrow(/wrong or/)
    const far = new Uint8Array(56 + CHUNK + 16 + 1)
    far.set(envelope)
    expect(() => decryptEnvelope(far, key)).toThrow(/length is invalid/)
  })

  it('an unknown magic', () => {
    const bad = envelope.slice()
    bad.set(new TextEncoder().encode('FSWNENC9'))
    expect(() => decryptEnvelope(bad, key)).toThrow(/not a Wildbloom encrypted envelope/)
  })

  it('a chunk size or record count the format does not allow', () => {
    const chunk = envelope.slice()
    new DataView(chunk.buffer).setUint32(8, 512 * 1024, false)
    expect(() => decryptEnvelope(chunk, key)).toThrow(/header is invalid/)
    const none = envelope.slice()
    new DataView(none.buffer).setUint32(12, 0, false)
    expect(() => decryptEnvelope(none, key)).toThrow(/header is invalid/)
    const many = envelope.slice()
    new DataView(many.buffer).setUint32(12, 259, false)
    expect(() => decryptEnvelope(many, key)).toThrow(/header is invalid/)
  })

  it('a plaintext that authenticates but is not canonical', () => {
    // Seal a record by hand under the vector's own header and key, with a
    // metadata object whose keys are in the wrong order. The tag passes;
    // the metadata rule refuses it.
    const header = envelope.slice(0, 56)
    const aes = deriveEnvelopeKey(hexToBytes(key), header.subarray(24, 56))
    const seal = (metadata: string, size: number): Uint8Array => {
      const bytes = new TextEncoder().encode(metadata)
      const plaintext = new Uint8Array(65536)
      new DataView(plaintext.buffer).setUint32(0, bytes.length, false)
      plaintext.set(bytes, 4)
      const nonce = new Uint8Array(12)
      nonce.set(header.subarray(16, 24))
      const aad = new Uint8Array(60)
      aad.set(header)
      const out = new Uint8Array(56 + 65536 + 16)
      out.set(header)
      out.set(gcm(aes, nonce, aad).encrypt(plaintext), 56)
      void size
      return out
    }
    expect(() => decryptEnvelope(seal('{"size":43,"name":"a.txt","type":"text/plain"}', 43), key)).toThrow(
      /not canonical/,
    )
    expect(() => decryptEnvelope(seal('{"name":"../a.txt","size":43,"type":"text/plain"}', 43), key)).toThrow(
      /file name is invalid/,
    )
    expect(() => decryptEnvelope(seal('{"name":"a.txt","size":43,"type":"Text/Plain"}', 43), key)).toThrow(
      /not canonical/,
    )
    // A size that does not fit the padding bucket the envelope has.
    expect(() => decryptEnvelope(seal('{"name":"a.txt","size":70000,"type":"text/plain"}', 70000), key)).toThrow(
      /padding is invalid/,
    )
    expect(() => decryptEnvelope(seal('{"name":"a.txt","size":0,"type":"text/plain"}', 0), key)).toThrow(
      /size is invalid/,
    )
    expect(() => decryptEnvelope(seal('{"name":"a.txt","size":43}', 43), key)).toThrow(/types are invalid/)
    expect(() => decryptEnvelope(seal('[]', 43), key)).toThrow(/invalid/)
    expect(() => decryptEnvelope(seal('nul', 43), key)).toThrow(/metadata is invalid/)
  })
})

describe('the recovery key', () => {
  const hex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
  const wbk = 'wbk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

  it('reads the form Wildbloom shows and the hex the chat carries', () => {
    expect(parseRecoveryKey(wbk)).toBe(hex)
    expect(parseRecoveryKey(`  ${wbk}\n`)).toBe(hex)
    expect(parseRecoveryKey(hex)).toBe(hex)
    expect(parseRecoveryKey(hex.toUpperCase())).toBe(hex)
    expect(formatRecoveryKey(hex)).toBe(wbk)
  })

  it('refuses a spelling that decodes to the same bits but is not canonical', () => {
    // The last base64url character carries two spare bits; a different
    // final character with the same top bits is the same key written
    // another way, and the format admits exactly one way.
    expect(() => parseRecoveryKey(wbk.slice(0, -1) + '9')).toThrow(/canonical/)
  })

  it('refuses anything else', () => {
    for (const bad of ['', 'wbk1_', 'wbk1_short', `wbk1_${'A'.repeat(43)}!`, hex.slice(1), 'wbk2_' + wbk.slice(5)]) {
      expect(() => parseRecoveryKey(bad), bad).toThrow()
    }
  })
})

describe('fetchAttachment', () => {
  const { envelope, v } = v2Envelope('fswnenc2-per-file')
  const att: ChatAttachment = {
    event: 'ab'.repeat(32),
    url: 'https://blossom.example/' + v.envelopeSha256,
    sha256: v.envelopeSha256,
    key: v.testOnlyInputKeyHex,
  }
  const serving = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
    vi.fn(async (_url: string, _init?: RequestInit) => new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, headers }))

  it('fetches, checks the hash, and opens the file', async () => {
    const fetch = serving(envelope)
    const opened = await fetchAttachment(att, { fetch: fetch as unknown as typeof globalThis.fetch })
    expect(opened.name).toBe('known-answer.txt')
    expect(new TextDecoder().decode(opened.source)).toBe(v.source.utf8)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe(att.url)
  })

  it('refuses a download that is not the file the message named, before trying the key', async () => {
    // A wrong key AND a wrong hash: the error names the hash, which is
    // the check that runs first, so the key was never applied.
    const fetch = serving(envelope)
    await expect(
      fetchAttachment({ ...att, sha256: '00'.repeat(32), key: '11'.repeat(32) }, { fetch: fetch as never }),
    ).rejects.toThrow(/not the file the message named/)
  })

  it('refuses a body larger than it will read, by header and by bytes', async () => {
    const byHeader = serving(envelope, { 'content-length': String(envelope.length) })
    await expect(fetchAttachment(att, { fetch: byHeader as never, maxBytes: 1000 })).rejects.toThrow(/larger/)
    const byBytes = serving(envelope)
    await expect(fetchAttachment(att, { fetch: byBytes as never, maxBytes: 1000 })).rejects.toThrow(/larger/)
  })

  it('refuses a plain http url without asking the network', async () => {
    const fetch = serving(envelope)
    await expect(fetchAttachment({ ...att, url: 'http://blossom.example/x' }, { fetch: fetch as never })).rejects.toThrow(
      /https/,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a server that says no', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('gone', { status: 404 }))
    await expect(fetchAttachment(att, { fetch: fetch as never })).rejects.toThrow(/404/)
  })
})

describe('the format helpers', () => {
  it('pads to the buckets the specification draws', () => {
    expect(paddedPlaintextLength(1)).toBe(65536)
    expect(paddedPlaintextLength(65536)).toBe(65536)
    expect(paddedPlaintextLength(65537)).toBe(131072)
    expect(paddedPlaintextLength(1048576)).toBe(1048576)
    expect(paddedPlaintextLength(1048577)).toBe(2097152)
    expect(paddedPlaintextLength(2 * 1048576 + 1)).toBe(3 * 1048576)
  })

  it('normalises a file name the way Wildbloom does', () => {
    expect(canonicalEnvelopeName('photo.jpg')).toBe('photo.jpg')
    expect(canonicalEnvelopeName('dir/sub\\photo.jpg')).toBe('photo.jpg')
    expect(canonicalEnvelopeName('..hidden')).toBe('hidden')
    expect(canonicalEnvelopeName('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h')
    expect(canonicalEnvelopeName('   ')).toBe('blob.bin')
    expect(canonicalEnvelopeName('x'.repeat(200))).toHaveLength(180)
  })

  it('verifies an envelope hash case-insensitively', () => {
    expect(verifyEnvelopeHash(envelope_(), v2Envelope('fswnenc2-per-file').v.envelopeSha256.toUpperCase())).toBe(true)
    expect(verifyEnvelopeHash(envelope_(), '00'.repeat(32))).toBe(false)
  })
})

function envelope_(): Uint8Array {
  return v2Envelope('fswnenc2-per-file').envelope
}
