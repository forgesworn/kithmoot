import { describe, expect, it, vi } from 'vitest'
import {
  decodeOrdinaryImage, encodeOrdinaryImage, openOrdinaryFrame, sealOrdinaryImage, sameOrdinaryFrame,
  validateOrdinaryFrame, validateOrdinaryKey, OrdinaryStateHold, ORDINARY_FENCES, ORDINARY_RECORDS,
  type OrdinaryImage, type OrdinaryFrame, ORDINARY_IMAGE_BYTES, ORDINARY_VALUE_BYTES, ordinaryUtf8Length, ordinaryImageByteLength,
} from './ordinary-state-codec.js'
const image = (): OrdinaryImage => ({ purpose: 'browser', keyId: '1'.repeat(64), generation: '2'.repeat(64), revision: 7,
  expiresAt: 0, records: new Map([['room/private', 'secret capability'], ['device/private', 'private key']]),
  migration: { phase: 'cleaning', sources: new Map([['old/b', 'b'], ['old/a', 'a']]), names: ['old/b', 'old/a'] },
  fences: new Map([['forgotten room', 4]]) })
const key = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
function bytes(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)) }
function raw() { return JSON.parse(new TextDecoder().decode(encodeOrdinaryImage(image()))) as unknown[] }

describe('ordinary whole-image custody encoding', () => {
  it('encodes one canonical sorted tuple and preserves exact values and migration state', () => {
    const input = image(), encoded = encodeOrdinaryImage(input)
    const expected = '[1,"browser","' + '1'.repeat(64) + '","' + '2'.repeat(64) + '",7,0,[["device/private","private key"],["room/private","secret capability"]],["cleaning",[["old/a","a"],["old/b","b"]],["old/a","old/b"]],[["forgotten room",4]]]'
    expect(new TextDecoder().decode(encoded)).toBe(expected)
    const decoded = decodeOrdinaryImage(encoded)
    expect([...decoded.records]).toEqual([['device/private', 'private key'], ['room/private', 'secret capability']])
    expect(encodeOrdinaryImage(decoded)).toEqual(encoded)
    expect([...input.records.keys()]).toEqual(['room/private', 'device/private'])
    expect(input.migration!.names).toEqual(['old/b', 'old/a'])
  })

  it.each(['duplicate record', 'out of order', 'duplicate fence', 'future fence', 'unknown phase', 'missing migration source', 'complete with values', 'duplicate source name', 'wrong tuple length', 'trailing newline generation', 'fractional revision', 'wrong purpose', 'browser lease', 'tab without lease'])(
    'holds malformed %s without guessing an empty image', change => {
      const value = raw()
      switch (change) {
        case 'duplicate record': value[6] = [['a', 'x'], ['a', 'y']]; break
        case 'out of order': value[6] = [['b', 'x'], ['a', 'y']]; break
        case 'duplicate fence': value[8] = [['a', 1], ['a', 2]]; break
        case 'future fence': value[8] = [['a', 8]]; break
        case 'unknown phase': value[7] = ['guess', [], []]; break
        case 'missing migration source': value[7] = ['sealed', [['a', 'x']], ['a', 'b']]; break
        case 'complete with values': value[7] = ['complete', [['a', 'x']], ['a']]; break
        case 'duplicate source name': value[7] = ['complete', [], ['a', 'a']]; break
        case 'wrong tuple length': value.push(null); break
        case 'trailing newline generation': value[3] = '2'.repeat(64) + '\n'; break
        case 'fractional revision': value[4] = 7.5; break
        case 'wrong purpose': value[1] = 'room:private'; break
        case 'browser lease': value[5] = 1; break
        case 'tab without lease': value[1] = 'tab:' + '3'.repeat(64); break
      }
      expect(() => decodeOrdinaryImage(bytes(value))).toThrow(OrdinaryStateHold)
    },
  )

  it('records per-source cleanup without forgetting declared names', () => {
    const input = image()
    input.migration = { phase: 'cleaning', sources: new Map([['old/b','b']]), names: ['old/a','old/b'] }
    const opened = decodeOrdinaryImage(encodeOrdinaryImage(input))
    expect([...opened.migration!.sources]).toEqual([['old/b','b']])
    expect(opened.migration!.names).toEqual(['old/a','old/b'])
    input.migration = { phase: 'complete', sources: new Map(), names: ['old/a','old/b'] }
    expect(decodeOrdinaryImage(encodeOrdinaryImage(input)).migration!.phase).toBe('complete')
  })
  it.each(['sealed', 'cleaning'] as const)('rejects an undeclared source in %s', phase => {
    const input = image()
    input.migration = { phase, sources: new Map([['other','secret']]), names: ['old/a'] }
    expect(() => encodeOrdinaryImage(input)).toThrow(OrdinaryStateHold)
  })

  it('holds invalid UTF-8 and noncanonical alternate JSON encodings', () => {
    expect(() => decodeOrdinaryImage(new Uint8Array([0xff]))).toThrow(OrdinaryStateHold)
    const encoded = new TextDecoder().decode(encodeOrdinaryImage(image()))
    for (const changed of [' ' + encoded, encoded + '\n', encoded.replace(',7,', ',7.0,'), encoded.replace('private key', 'private\\u0020key')]) {
      expect(() => decodeOrdinaryImage(new TextEncoder().encode(changed))).toThrow(OrdinaryStateHold)
    }
  })

  it('keeps deletion fences and records at capacity, holding additions rather than evicting', () => {
    const input = image()
    input.records = new Map(Array.from({ length: ORDINARY_RECORDS }, (_, i) => [String(i).padStart(6, '0'), 'x']))
    input.fences = new Map(Array.from({ length: ORDINARY_FENCES }, (_, i) => [String(i).padStart(6, '0'), 1]))
    const encoded = encodeOrdinaryImage(input)
    expect(decodeOrdinaryImage(encoded).records.size).toBe(ORDINARY_RECORDS)
    expect(decodeOrdinaryImage(encoded).fences.size).toBe(ORDINARY_FENCES)
    const more = new Map(input.fences); more.set('extra', 1)
    expect(() => encodeOrdinaryImage({ ...input, fences: more })).toThrow(OrdinaryStateHold)
    expect(input.fences.size).toBe(ORDINARY_FENCES)
  })

  it('bounds encoded UTF-8 bytes even when each individual value fits', () => {
    const input = image()
    input.records = new Map(Array.from({ length: 17 }, (_, i) => [String(i), '𐀀'.repeat(500_000)]))
    expect(() => encodeOrdinaryImage(input)).toThrow(OrdinaryStateHold)
  })

  it.each(['🧭', 'é', '"'])('measures the exact raw UTF-8 boundary for %s', text => {
    const width = new TextEncoder().encode(text).length
    const raw = text.repeat(ORDINARY_VALUE_BYTES / width)
    expect(ordinaryUtf8Length(raw)).toBe(ORDINARY_VALUE_BYTES)
    const input = image(); input.records = new Map([['large', raw]])
    const encoded = encodeOrdinaryImage(input)
    expect(encoded.length).toBeLessThanOrEqual(ORDINARY_IMAGE_BYTES); encoded.fill(0)
    expect(() => encodeOrdinaryImage({ ...input, records: new Map([['large', raw + 'x']]) })).toThrow(OrdinaryStateHold)
    expect(input.records.get('large')).toBe(raw)
  })

  it('matches actual canonical encoding for controls, lone surrogates and astral pairs', () => {
    const input = image(); input.records = new Map([['a\u0000\\"\ud800', '\b\t\n\f\r\u0000\u001f\ud800x\udfff🧭é']])
    const encoded = encodeOrdinaryImage(input)
    expect(decodeOrdinaryImage(encoded).records).toEqual(input.records)
    expect(ordinaryUtf8Length('\ud800x\udfff🧭é')).toBe(new TextEncoder().encode('\ud800x\udfff🧭é').length)
  })

  it('caps scanning when the maximum number of records share a maximum-size string', () => {
    const input = image(), value = 'x'.repeat(ORDINARY_VALUE_BYTES)
    input.records = new Map(Array.from({ length: ORDINARY_RECORDS }, (_, i) => [String(i).padStart(6, '0'), value]))
    const read = String.prototype.charCodeAt; let inspected = 0
    String.prototype.charCodeAt = function (i) { inspected++; return read.call(this, i) }
    try { expect(() => encodeOrdinaryImage(input)).toThrow(OrdinaryStateHold) }
    finally { String.prototype.charCodeAt = read }
    expect(inspected).toBeLessThanOrEqual(ORDINARY_IMAGE_BYTES)
    expect(input.records.size).toBe(ORDINARY_RECORDS)
  })

  it('rejects aggregate escaping and migration duplication before whole-image string allocation', () => {
    const input = image(), raw = '\u0000'.repeat(ORDINARY_VALUE_BYTES)
    input.records = new Map([['large', raw]])
    input.migration = { phase: 'sealed', sources: input.records, names: ['large'] }
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect(() => encodeOrdinaryImage(input)).toThrow(OrdinaryStateHold)
      expect(stringify).not.toHaveBeenCalled()
    } finally { stringify.mockRestore() }
    expect(input.records.get('large')).toBe(raw)
  })

  // Three full 32 MiB scans plus canonical allocation: this is a byte-bound
  // acceptance case, with a separate budget for concurrent CI scheduling.
  it('admits exactly 32 MiB with sealed duplication and rejects the next canonical byte', () => {
    const input = image(); input.revision = 9; input.fences = new Map()
    let names = ['a', 'b']; input.records = new Map(names.map(name => [name, '']))
    input.migration = { phase: 'sealed', sources: input.records, names }
    let overhead = encodeOrdinaryImage(input).length
    if ((ORDINARY_IMAGE_BYTES - overhead) % 2) {
      names = ['a', 'bb']; input.records = new Map(names.map(name => [name, '']))
      input.migration = { phase: 'sealed', sources: input.records, names }; overhead = encodeOrdinaryImage(input).length
    }
    const second = (ORDINARY_IMAGE_BYTES - overhead) / 2 - ORDINARY_VALUE_BYTES
    input.records = new Map([[names[0]!, 'x'.repeat(ORDINARY_VALUE_BYTES)], [names[1]!, 'y'.repeat(second)]])
    input.migration = { phase: 'sealed', sources: input.records, names }
    expect(ordinaryImageByteLength(input)).toBe(ORDINARY_IMAGE_BYTES)
    const encoded = encodeOrdinaryImage(input); expect(encoded.length).toBe(ORDINARY_IMAGE_BYTES); encoded.fill(0)
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect(() => encodeOrdinaryImage({ ...input, revision: 10 })).toThrow(OrdinaryStateHold)
      expect(stringify).not.toHaveBeenCalled()
    } finally { stringify.mockRestore() }
  }, 15_000)

  it('uses non-extractable custody, fresh 96-bit nonces and exact whole-frame equality', async () => {
    const secret = await key()
    expect(validateOrdinaryKey(secret)).toBe(secret)
    await expect(crypto.subtle.exportKey('raw', secret)).rejects.toThrow()
    const first = await sealOrdinaryImage(image(), secret), second = await sealOrdinaryImage(image(), secret)
    expect(first.nonce.byteLength).toBe(12)
    expect(new Uint8Array(first.nonce)).not.toEqual(new Uint8Array(second.nonce))
    expect(sameOrdinaryFrame(first, structuredClone(first))).toBe(true)
    expect(sameOrdinaryFrame(first, second)).toBe(false)
    const opened = await openOrdinaryFrame(first, secret)
    expect(encodeOrdinaryImage(opened)).toEqual(encodeOrdinaryImage(image()))
    const stored = JSON.stringify({ ...first, nonce: [...new Uint8Array(first.nonce)], ciphertext: [...new Uint8Array(first.ciphertext)] })
    expect(stored).not.toContain('room/private')
    expect(stored).not.toContain('secret capability')
    expect(stored).not.toContain('private key')
  })

  it.each(['purpose', 'keyId', 'generation', 'revision', 'expiresAt', 'nonce', 'ciphertext'] as const)('binds %s against substitution', async field => {
    const secret = await key(), frame = await sealOrdinaryImage(image(), secret)
    if (field === 'purpose') { frame.purpose = `tab:${'4'.repeat(64)}`; frame.expiresAt = 1 }
    else if (field === 'keyId' || field === 'generation') frame[field] = '4'.repeat(64)
    else if (field === 'revision') frame.revision++
    else if (field === 'expiresAt') frame.expiresAt++
    else new Uint8Array(frame[field])[0]! ^= 1
    await expect(openOrdinaryFrame(frame, secret)).rejects.toThrow(OrdinaryStateHold)
  })

  it('holds wrong, extractable or incorrectly constrained keys and extra frame fields', async () => {
    const secret = await key(), frame = await sealOrdinaryImage(image(), secret)
    await expect(openOrdinaryFrame(frame, await key())).rejects.toThrow(OrdinaryStateHold)
    const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    expect(() => validateOrdinaryKey(extractable)).toThrow(OrdinaryStateHold)
    const short = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt'])
    expect(() => validateOrdinaryKey(short)).toThrow(OrdinaryStateHold)
    expect(() => validateOrdinaryFrame({ ...frame, roomId: 'leaked' })).toThrow(OrdinaryStateHold)
    expect(() => validateOrdinaryFrame({ ...frame, nonce: new ArrayBuffer(8) })).toThrow(OrdinaryStateHold)
  })

  it('compares a maximum-size frame without per-byte view allocations and detects a late difference', () => {
    const native = Uint8Array
    const first: OrdinaryFrame = { version: 1, purpose: 'browser', keyId: '1'.repeat(64), generation: '2'.repeat(64),
      revision: 0, expiresAt: 0, nonce: new ArrayBuffer(12), ciphertext: new ArrayBuffer(ORDINARY_IMAGE_BYTES + 16) }
    const copy = structuredClone(first)
    let views = 0
    vi.stubGlobal('Uint8Array', new Proxy(native, { construct(target, args) { views++; return Reflect.construct(target, args) } }))
    try {
      expect(sameOrdinaryFrame(first, copy)).toBe(true)
      expect(views).toBeLessThanOrEqual(8)
      new native(copy.ciphertext)[ORDINARY_IMAGE_BYTES + 15] = 1
      expect(sameOrdinaryFrame(first, copy)).toBe(false)
      expect(views).toBeLessThanOrEqual(16)
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects getter-backed substitution without invoking the getter, including an oversized second value', async () => {
    const secret = await key(), frame = await sealOrdinaryImage(image(), secret)
    let reads = 0
    Object.defineProperty(frame, 'ciphertext', { enumerable: true, get() {
      return ++reads === 1 ? new ArrayBuffer(16) : new ArrayBuffer(ORDINARY_IMAGE_BYTES + 17)
    } })
    expect(() => validateOrdinaryFrame(frame)).toThrow(OrdinaryStateHold)
    await expect(openOrdinaryFrame(frame, secret)).rejects.toThrow(OrdinaryStateHold)
    expect(reads).toBe(0)
  })

  it('holds detached, uncloneable and non-plain frames through the same error boundary', async () => {
    const secret = await key(), frame = await sealOrdinaryImage(image(), secret)
    const detached = structuredClone(frame)
    structuredClone(detached.ciphertext, { transfer: [detached.ciphertext] })
    const bad = [detached, { ...frame, purpose: () => {} }, Object.assign(Object.create({ secret: 'inherited' }), frame),
      new Proxy(frame, { getOwnPropertyDescriptor() { throw new Error('untrusted descriptor failure') } })]
    for (const value of bad) {
      expect(() => validateOrdinaryFrame(value)).toThrow(OrdinaryStateHold)
      await expect(openOrdinaryFrame(value, secret)).rejects.toThrow(OrdinaryStateHold)
    }
  })

  it('validates the owned clone again before crypto if cloning substitutes oversized data', async () => {
    const secret = await key(), frame = await sealOrdinaryImage(image(), secret)
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => ({ ...frame, ciphertext: new ArrayBuffer(ORDINARY_IMAGE_BYTES + 17) }))
    try {
      expect(() => validateOrdinaryFrame(frame)).toThrow(OrdinaryStateHold)
      await expect(openOrdinaryFrame(frame, secret)).rejects.toThrow(OrdinaryStateHold)
    } finally { clone.mockRestore() }
  })

  it('freezes caller-owned ciphertext and header before an asynchronous decrypt', async () => {
    const secret = await key(), frame = await sealOrdinaryImage(image(), secret)
    const opened = openOrdinaryFrame(frame, secret)
    frame.revision++
    new Uint8Array(frame.ciphertext).fill(0)
    expect(encodeOrdinaryImage(await opened)).toEqual(encodeOrdinaryImage(image()))
  })
})
