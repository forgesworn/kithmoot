import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure'
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
  encryptEnvelope,
  uploadEnvelope,
  buildFileEvent,
  buildUploadAuthorisation,
  encodeBlossomAuthorisation,
  normaliseBlossomServer,
  ENVELOPE_MEDIA_TYPE,
  ENVELOPE_FILE_NAME,
  ENVELOPE_SCHEME,
  MAX_UPLOAD_SOURCE_BYTES,
  UPLOAD_AUTHORISATION_LIFETIME_SECONDS,
  type BlossomDescriptor,
} from './attachment.js'
import { normaliseAttachment, type ChatAttachment } from './chat.js'

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
    // A two-record vector is a 2 MiB envelope built, hashed, and opened a
    // megabyte at a time, and the recipe is rebuilt rather than read, so
    // this is real work rather than a hang. Measured: 1.3s on an M4 under
    // Node 24, 5.0s on a CI runner under Node 22 - which is over vitest's
    // default and turned a slow test into a red build. The budget is what
    // separates "slow" from "wedged", so it is stated rather than removed.
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
    }, 30_000)
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

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The published vectors' padding rule, so their bytes can be reproduced. */
const vectorPadding = (i: number): number => (i * 73 + 41) % 256

describe('encryptEnvelope reproduces the FSWNENC2 vectors byte for byte', () => {
  for (const name of ['fswnenc2-per-file', 'fswnenc2-vault']) {
    it(`writes ${name}`, () => {
      const { envelope: published, v } = v2Envelope(name)
      const sealed = encryptEnvelope(new TextEncoder().encode(v.source.utf8), { name: v.source.name, type: v.source.type }, {
        key: hexToBytes(v.testOnlyInputKeyHex),
        salt: hexToBytes(v.saltHex),
        noncePrefix: hexToBytes(v.noncePrefixHex),
        padding: vectorPadding,
      })
      expect(sealed.envelope.length).toBe(v.envelopeBytes)
      expect(bytesToHex(sealed.envelope.subarray(0, 56))).toBe(v.headerHex)
      expect(bytesToHex(sealed.envelope.subarray(sealed.envelope.length - 16))).toBe(v.records[0].authenticationTagHex)
      expect(sealed.sha256).toBe(v.envelopeSha256)
      expect(bytesToHex(sealed.envelope)).toBe(bytesToHex(published))
      expect(sealed.key).toBe(v.testOnlyInputKeyHex)
      expect(sealed.name).toBe(v.source.name)
      expect(sealed.type).toBe(v.source.type)
      expect(sealed.size).toBe(v.source.bytes)
      // And the metadata inside is the vector's canonical bytes: the reader
      // would refuse anything else.
      const opened = decryptEnvelope(sealed.envelope, sealed.key)
      expect(new TextDecoder().decode(opened.source)).toBe(v.source.utf8)
    })
  }

  it('writes the FSWNENC1 vectors\' plaintext under the v2 header, which is all that changed', () => {
    // The two-record recipe vector proves the record split: its source
    // straddles the 1 MiB boundary. Sealed as FSWNENC2 it cannot match the
    // FSWNENC1 bytes, but it must open to the same file with the same
    // record count.
    const v = vector('encryption-v2-two-records') as RecipeVector
    const source = sourceOf(v)
    const sealed = encryptEnvelope(source, { name: v.source.name, type: v.source.type }, {
      key: hexToBytes(v.testOnlyKey.rawHex),
      noncePrefix: hexToBytes(v.noncePrefixHex),
      salt: new Uint8Array(32),
      padding: vectorPadding,
    })
    expect(sealed.envelope.length).toBe(56 + v.padding.plaintextBytes + 2 * 16)
    expect(new DataView(sealed.envelope.buffer).getUint32(12, false)).toBe(2)
    const opened = decryptEnvelope(sealed.envelope, v.testOnlyKey.rawHex)
    expect(sha256Hex(opened.source)).toBe(v.source.sha256)
  })
})

describe('encryptEnvelope on its own', () => {
  const picture = new Uint8Array(3 * CHUNK + 17)
  for (let i = 0; i < picture.length; i += 1) picture[i] = (i * 31 + 5) % 256

  it('round-trips through the reader, with a fresh key every time', () => {
    const a = encryptEnvelope(picture, { name: 'IMG_0001.JPG', type: 'image/jpeg' })
    const b = encryptEnvelope(picture, { name: 'IMG_0001.JPG', type: 'image/jpeg' })
    expect(a.key).not.toBe(b.key)
    expect(a.sha256).not.toBe(b.sha256)
    expect(bytesToHex(a.envelope.subarray(16, 24))).not.toBe(bytesToHex(b.envelope.subarray(16, 24)))
    expect(bytesToHex(a.envelope.subarray(24, 56))).not.toBe(bytesToHex(b.envelope.subarray(24, 56)))
    // 4 MiB bucket: 4 + 57-odd metadata + 3 MiB + 17 rounds up to 4 records.
    expect(a.envelope.length).toBe(56 + 4 * CHUNK + 4 * 16)
    expect(a.sha256).toBe(sha256Hex(a.envelope))
    expect(verifyEnvelopeHash(a.envelope, a.sha256)).toBe(true)
    for (const sealed of [a, b]) {
      const opened = decryptEnvelope(sealed.envelope, sealed.key)
      expect(opened.name).toBe('IMG_0001.JPG')
      expect(opened.type).toBe('image/jpeg')
      expect(opened.size).toBe(picture.length)
      expect(sha256Hex(opened.source)).toBe(sha256Hex(picture))
    }
    // The key it hands back is the key Wildbloom would show.
    expect(parseRecoveryKey(formatRecoveryKey(a.key))).toBe(a.key)
  })

  it('pads with something other than zeros', () => {
    const tiny = new TextEncoder().encode('hi')
    const sealed = encryptEnvelope(tiny, { name: 'hi.txt', type: 'text/plain' })
    // Decrypt record 0 by hand and look at the padding region.
    const header = sealed.envelope.subarray(0, 56)
    const key = deriveEnvelopeKey(hexToBytes(sealed.key), header.subarray(24, 56))
    const nonce = new Uint8Array(12)
    nonce.set(header.subarray(16, 24))
    const aad = new Uint8Array(60)
    aad.set(header)
    const plaintext = gcm(key, nonce, aad).decrypt(sealed.envelope.subarray(56))
    expect(plaintext.length).toBe(65536)
    const padding = plaintext.subarray(4 + new DataView(plaintext.buffer).getUint32(0, false) + tiny.length)
    expect(padding.length).toBeGreaterThan(65000)
    expect(padding.some((b) => b !== 0)).toBe(true)
    expect(new Set(padding).size).toBeGreaterThan(200)
  })

  it('stores the name and type the way Wildbloom does', () => {
    const sealed = encryptEnvelope(picture.subarray(0, 100), { name: 'C:\\\\photos\\\\..a<b>.PNG', type: '' })
    expect(sealed.name).toBe('a_b_.PNG')
    expect(sealed.type).toBe('application/octet-stream')
    const opened = decryptEnvelope(sealed.envelope, sealed.key)
    expect(opened.name).toBe('a_b_.PNG')
    expect(opened.type).toBe('application/octet-stream')
    expect(encryptEnvelope(picture.subarray(0, 1), { name: 'x', type: 'Image/PNG' }).type).toBe('image/png')
    expect(() => encryptEnvelope(picture.subarray(0, 1), { name: 'x', type: 'a\u0000b' })).toThrow(/media type/)
  })

  // The cap is 64 MiB, and proving a caller may raise it means encrypting a
  // buffer that size for real. Same reasoning as the vectors above: seconds
  // of genuine work, close enough to vitest's default to go red on a busy
  // machine, so the budget is written down rather than left to luck.
  it('refuses an empty file, a file over the cap, and the wrong-size secrets', () => {
    expect(() => encryptEnvelope(new Uint8Array(0), { name: 'x', type: '' })).toThrow(/empty/)
    expect(() => encryptEnvelope(picture, { name: 'x', type: '' }, { maxSourceBytes: CHUNK })).toThrow(/larger than 1 MiB/)
    expect(MAX_UPLOAD_SOURCE_BYTES).toBe(64 * 1024 * 1024)
    expect(() => encryptEnvelope(new Uint8Array(MAX_UPLOAD_SOURCE_BYTES + 1), { name: 'x', type: '' })).toThrow(
      /larger than 64 MiB/,
    )
    // The cap can be raised by a caller, but never past the format's own.
    expect(() =>
      encryptEnvelope(new Uint8Array(MAX_UPLOAD_SOURCE_BYTES + 1), { name: 'x', type: '' }, { maxSourceBytes: Infinity }),
    ).not.toThrow()
    expect(() => encryptEnvelope(picture, { name: 'x', type: '' }, { key: new Uint8Array(16) })).toThrow(/key must be 32/)
    expect(() => encryptEnvelope(picture, { name: 'x', type: '' }, { salt: new Uint8Array(16) })).toThrow(/salt must be 32/)
    expect(() => encryptEnvelope(picture, { name: 'x', type: '' }, { noncePrefix: new Uint8Array(12) })).toThrow(
      /nonce prefix must be 8/,
    )
  }, 30_000)

  it('what it writes, the reader refuses when anybody touches it', () => {
    const sealed = encryptEnvelope(picture, { name: 'p.bin', type: '' })
    const cases: Array<[string, number]> = [
      ['the magic', 0],
      ['the record count', 15],
      ['the nonce prefix', 20],
      ['the salt', 40],
      ['the first record', 56 + 1000],
      ['the last record', sealed.envelope.length - 500],
      ['a tag', sealed.envelope.length - 1],
    ]
    for (const [what, at] of cases) {
      const bad = sealed.envelope.slice()
      bad[at] ^= 0x01
      expect(() => decryptEnvelope(bad, sealed.key), what).toThrow()
    }
    expect(() => decryptEnvelope(sealed.envelope, '00'.repeat(32))).toThrow(/wrong or/)
    // A byte off the end: the plaintext no longer fits its padding bucket,
    // which the reader notices from record 0 before it reaches the tag.
    expect(() => decryptEnvelope(sealed.envelope.subarray(0, sealed.envelope.length - 1), sealed.key)).toThrow(
      /padding is invalid/,
    )
  })
})

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

/** Wildbloom's own checks on an authorisation header, reproduced from its
 *  `encodeNostrAuthorisation`, so the header this sends is one Wildbloom's
 *  server-side checks would accept. */
function wildbloomWouldAccept(header: string, nowSeconds: number): Event {
  expect(header.startsWith('Nostr ')).toBe(true)
  const b64 = header.slice('Nostr '.length)
  expect(/^[A-Za-z0-9+/]+={0,2}$/.test(b64)).toBe(true)
  const event = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Event
  expect(verifyEvent(event)).toBe(true)
  expect(event.kind).toBe(24242)
  const tag = (n: string): string[] => event.tags.filter((t) => t[0] === n).map((t) => t[1] as string)
  expect(tag('t')).toEqual(['upload'])
  const [expiration] = tag('expiration')
  expect(expiration).toMatch(/^[0-9]{1,16}$/)
  const lifetime = Number(expiration) - event.created_at
  expect(lifetime).toBeGreaterThanOrEqual(30)
  expect(lifetime).toBeLessThanOrEqual(300)
  expect(event.created_at).toBeLessThan(nowSeconds)
  expect(Number(expiration)).toBeGreaterThan(nowSeconds)
  const [server] = tag('server')
  expect(server).toBe(server?.toLowerCase())
  expect(new URL(`https://${server}`).hostname).toBe(server)
  const [x] = tag('x')
  expect(x).toMatch(/^[0-9a-f]{64}$/)
  expect(event.content).toBe(`Upload blob ${x} to ${server}`)
  return event
}

describe('uploadEnvelope', () => {
  const sk = generateSecretKey()
  const sign = (t: EventTemplate): Event => finalizeEvent(t, sk)
  const sealed = encryptEnvelope(new TextEncoder().encode('a small picture'), { name: 'p.png', type: 'image/png' })
  const server = 'https://blossom.example'
  const now = 1_800_000_000
  const descriptorFor = (over: Partial<Record<keyof BlossomDescriptor | 'uploaded', unknown>> = {}): unknown => ({
    url: `${server}/${sealed.sha256}.bin`,
    sha256: sealed.sha256,
    size: sealed.envelope.length,
    type: ENVELOPE_MEDIA_TYPE,
    uploaded: now,
    ...over,
  })
  const answering = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
    )

  it('PUTs the bytes with an authorisation Wildbloom would accept, and returns where they landed', async () => {
    const fetch = answering(200, descriptorFor())
    const got = await uploadEnvelope(server, sealed.envelope, { sign, fetch: fetch as never, now: () => now })
    expect(got).toEqual({
      url: `${server}/${sealed.sha256}.bin`,
      sha256: sealed.sha256,
      size: sealed.envelope.length,
      type: ENVELOPE_MEDIA_TYPE,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${server}/upload`)
    expect(init.method).toBe('PUT')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe(ENVELOPE_MEDIA_TYPE)
    expect(headers['X-SHA-256']).toBe(sealed.sha256)
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(sealed.envelope)
    // The authorisation names these bytes, this host, this key, briefly.
    const auth = wildbloomWouldAccept(headers.Authorization as string, now)
    expect(auth.pubkey).toBe(getPublicKey(sk))
    expect(auth.tags).toEqual([
      ['t', 'upload'],
      ['expiration', String(now - 1 + UPLOAD_AUTHORISATION_LIFETIME_SECONDS)],
      ['server', 'blossom.example'],
      ['x', sealed.sha256],
    ])
    expect(auth.created_at).toBe(now - 1)
  })

  it('takes a 201 and a descriptor url without an extension', async () => {
    const fetch = answering(201, descriptorFor({ url: `${server}/${sealed.sha256}` }))
    const got = await uploadEnvelope(server, sealed.envelope, { sign, fetch: fetch as never })
    expect(got.url).toBe(`${server}/${sealed.sha256}`)
  })

  it('says plainly when the server says no', async () => {
    const opts = { sign, now: () => now }
    await expect(uploadEnvelope(server, sealed.envelope, { ...opts, fetch: answering(401, '') as never })).rejects.toThrow(
      /refused the upload authorisation \(401\)/,
    )
    await expect(
      uploadEnvelope(server, sealed.envelope, { ...opts, fetch: answering(403, '', { 'X-Reason': 'not on the list' }) as never }),
    ).rejects.toThrow(/refused the upload authorisation \(403: not on the list\)/)
    await expect(uploadEnvelope(server, sealed.envelope, { ...opts, fetch: answering(413, '') as never })).rejects.toThrow(
      /will not take a file this big \(413\)/,
    )
    await expect(
      uploadEnvelope(server, sealed.envelope, { ...opts, fetch: answering(500, '', { 'X-Reason': ' disk full ' }) as never }),
    ).rejects.toThrow(/answered 500: disk full\./)
    await expect(uploadEnvelope(server, sealed.envelope, { ...opts, fetch: answering(502, '') as never })).rejects.toThrow(
      /answered 502\./,
    )
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(uploadEnvelope(server, sealed.envelope, { ...opts, fetch: down as never })).rejects.toThrow(
      /Could not reach blossom\.example\./,
    )
  })

  it('refuses a descriptor that is not for the bytes it sent', async () => {
    const opts = { sign, now: () => now }
    const cases: Array<[unknown, RegExp]> = [
      [descriptorFor({ sha256: '00'.repeat(32) }), /different bytes/],
      [descriptorFor({ size: sealed.envelope.length + 1 }), /different size/],
      [descriptorFor({ url: `https://elsewhere.example/${sealed.sha256}` }), /somewhere other than itself/],
      [descriptorFor({ url: `${server}/${'00'.repeat(32)}` }), /by its hash/],
      [descriptorFor({ url: `${server}/${sealed.sha256}?x=1` }), /somewhere other than itself/],
      [descriptorFor({ url: undefined }), /where the blob is/],
      ['not json', /did not answer with a blob descriptor/],
      [[], /did not answer with a blob descriptor/],
    ]
    for (const [body, why] of cases) {
      await expect(
        uploadEnvelope(server, sealed.envelope, { ...opts, fetch: answering(200, body) as never }),
        JSON.stringify(body),
      ).rejects.toThrow(why)
    }
  })

  it('refuses a server that is not an https origin, without asking the network', async () => {
    const fetch = answering(200, descriptorFor())
    for (const bad of ['http://blossom.example', 'https://blossom.example/path', 'https://u:p@blossom.example', 'blossom', '']) {
      await expect(uploadEnvelope(bad, sealed.envelope, { sign, fetch: fetch as never }), bad).rejects.toThrow(/Blossom server/)
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(normaliseBlossomServer(' https://Blossom.Example/ ')).toBe('https://blossom.example')
    expect(normaliseBlossomServer('https://blossom.example:8443')).toBe('https://blossom.example:8443')
  })

  it('refuses a signer that signs something other than what it was handed', async () => {
    const fetch = answering(200, descriptorFor())
    const meddling = (t: EventTemplate): Event => finalizeEvent({ ...t, tags: [...t.tags, ['extra', 'tag']] }, sk)
    await expect(uploadEnvelope(server, sealed.envelope, { sign: meddling, fetch: fetch as never })).rejects.toThrow(
      /did not sign the upload authorisation as written/,
    )
    const forging = (t: EventTemplate): Event => ({ ...finalizeEvent(t, sk), sig: '00'.repeat(64) })
    await expect(uploadEnvelope(server, sealed.envelope, { sign: forging, fetch: fetch as never })).rejects.toThrow(
      /did not sign the upload authorisation as written/,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('builds the authorisation the way Wildbloom does', () => {
    const t = buildUploadAuthorisation(sealed.sha256.toUpperCase(), 'https://Blossom.Example', now)
    expect(t).toEqual({
      kind: 24242,
      created_at: now - 1,
      tags: [
        ['t', 'upload'],
        ['expiration', String(now - 1 + 90)],
        ['server', 'blossom.example'],
        ['x', sealed.sha256],
      ],
      content: `Upload blob ${sealed.sha256} to blossom.example`,
    })
    expect(() => buildUploadAuthorisation('nope', server, now)).toThrow(/64 hex/)
    const header = encodeBlossomAuthorisation(finalizeEvent(t, sk))
    wildbloomWouldAccept(header, now)
  })
})

// ---------------------------------------------------------------------------
// The file event
// ---------------------------------------------------------------------------

describe('buildFileEvent', () => {
  const hash = 'ab'.repeat(32)
  const descriptor = { url: `https://blossom.example/${hash}.bin`, sha256: hash, size: 65608 }

  it('writes every tag Wildbloom writes, and nothing about the file', () => {
    const t = buildFileEvent(descriptor, 1_800_000_000)
    expect(t).toEqual({
      kind: 1063,
      created_at: 1_800_000_000,
      tags: [
        ['url', descriptor.url],
        ['m', ENVELOPE_MEDIA_TYPE],
        ['x', hash],
        ['ox', hash],
        ['size', '65608'],
        ['encryption', ENVELOPE_SCHEME],
        ['alt', 'Encrypted Wildbloom file'],
      ],
      content: ENVELOPE_FILE_NAME,
    })
    expect(JSON.stringify(t)).not.toMatch(/holiday|jpeg|image/)
  })

  it('is what a Wildbloom client resolves: x and ox agree, the url names x, the scheme is one it knows', () => {
    const t = buildFileEvent(descriptor)
    const tag = (n: string): string[] => t.tags.filter((x) => x[0] === n).map((x) => x[1] as string)
    expect(tag('x')).toHaveLength(1)
    expect(tag('x')).toEqual(tag('ox'))
    const leaf = new URL(tag('url')[0] as string).pathname.split('/').at(-1)
    expect(leaf).toMatch(new RegExp(`^${hash}(\\.[a-z0-9]{1,10})?$`))
    expect(Number(tag('size')[0])).toBeGreaterThan(0)
    expect(['forgesworn-aes-256-gcm-chunked-v1', 'forgesworn-aes-256-gcm-chunked-v2']).toContain(tag('encryption')[0])
    expect(canonicalEnvelopeName(t.content)).toBe(t.content)
    expect(t.content).toBe('wildbloom.wbenc')
  })

  it('refuses what a client would refuse', () => {
    expect(() => buildFileEvent({ ...descriptor, url: `http://blossom.example/${hash}` })).toThrow(/https/)
    expect(() => buildFileEvent({ ...descriptor, sha256: 'nope' })).toThrow(/64 hex/)
    expect(() => buildFileEvent({ ...descriptor, size: 0 })).toThrow(/positive/)
    expect(() => buildFileEvent({ ...descriptor, size: 1.5 })).toThrow(/positive/)
  })
})

describe('the whole drop, end to end', () => {
  it('seals, uploads, announces, and the room opens it as a Wildbloom share', async () => {
    const sk = generateSecretKey()
    const source = new Uint8Array(200_000)
    for (let i = 0; i < source.length; i += 1) source[i] = (i * 7 + 3) % 256
    const sealed = encryptEnvelope(source, { name: 'whiteboard.png', type: 'image/png' })

    // A Blossom server that keeps what it is given and serves it back.
    const store = new Map<string, Uint8Array>()
    const server = 'https://blossom.example'
    const blossom = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const bytes = new Uint8Array(init.body as ArrayBuffer)
        const hash = sha256Hex(bytes)
        store.set(hash, bytes)
        return new Response(JSON.stringify({ url: `${server}/${hash}`, sha256: hash, size: bytes.length, type: 'x', uploaded: 1 }))
      }
      const hash = new URL(url).pathname.slice(1)
      const bytes = store.get(hash)
      return bytes ? new Response(bytes.slice().buffer as ArrayBuffer) : new Response('', { status: 404 })
    })

    const descriptor = await uploadEnvelope(server, sealed.envelope, { sign: (t) => finalizeEvent(t, sk), fetch: blossom as never })
    const event = finalizeEvent(buildFileEvent(descriptor), sk)
    expect(verifyEvent(event)).toBe(true)

    // What the chat carries, exactly as the paste path builds it.
    const share = normaliseAttachment({
      event: event.id,
      url: event.tags.find((t) => t[0] === 'url')?.[1],
      sha256: event.tags.find((t) => t[0] === 'x')?.[1],
      key: sealed.key,
      name: sealed.name,
      type: sealed.type,
      size: sealed.envelope.length,
    })
    expect(share).not.toBeNull()
    expect(share?.size).toBe(sealed.envelope.length)
    expect(share?.name).toBe('whiteboard.png')

    // And a member who clicks gets the picture back.
    const opened = await fetchAttachment(share as ChatAttachment, { fetch: blossom as never })
    expect(opened.name).toBe('whiteboard.png')
    expect(opened.type).toBe('image/png')
    expect(sha256Hex(opened.source)).toBe(sha256Hex(source))
    // Nothing the server or the relay saw carries the key or the name.
    const seen = JSON.stringify(event) + (blossom.mock.calls[0]?.[1] as RequestInit).headers
    expect(seen).not.toContain(sealed.key)
    expect(seen).not.toContain('whiteboard')
  })
})
