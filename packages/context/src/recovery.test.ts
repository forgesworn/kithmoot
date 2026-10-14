import { expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { ContextVault, CONTEXT_CACHE_BYTES, CONTEXT_ENVELOPE_V2_BYTES } from './index.js'
import { contextTextFits } from './limits.js'
import { inspectEnvelopeHeader, sha256Hex } from './blossom.js'
import { recoveryIdentity, aggregateRecoveryFixture } from '../../../test/context-recovery-fixture.js'
import { LEGACY_CONTEXT_CACHES } from '../../../test/ordinary-journal-legacy-vectors.js'

const origin = 'https://storage.example'
const secret = new Uint8Array(32).fill(7)
const bytes = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))
const base64 = (data: Uint8Array) => Buffer.from(data).toString('base64')
const stored = (raw: string) => JSON.parse(raw).collections[0]
async function reseal(identity: ReturnType<typeof recoveryIdentity>, row: any, change: (body: any) => void) {
  const sealed = JSON.parse(row.access.content), body = JSON.parse(await identity.decrypt(identity.pubkey, sealed.ciphertext))
  change(body)
  sealed.ciphertext = await identity.encrypt(identity.pubkey, JSON.stringify(body))
  row.access = finalizeEvent({ ...row.access, content: JSON.stringify(sealed) }, secret)
}

it('sizes UTF-8 without a full encoded allocation, including replacement and surrogate pairs', () => {
  for (const text of ['', 'ascii', 'é', '😀', '\ud800', '\udc00', 'a😀é\ud800']) {
    const n = new TextEncoder().encode(text).length
    expect(contextTextFits(text, n)).toBe(true)
    if (n) expect(contextTextFits(text, n - 1)).toBe(false)
  }
  expect(CONTEXT_CACHE_BYTES).toBe(123037605)
})

it('restores, resaves, uploads and imports the exact maximum V2 writer envelope', async () => {
  const identity = recoveryIdentity({ snapshotCeiling: true })
  const blobs = new Map<string, Uint8Array>()
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === 'PUT') {
      const data = new Uint8Array(init.body as ArrayBuffer), hash = sha256Hex(data), url = `${origin}/${hash}`
      blobs.set(url, data)
      return Response.json({ url, sha256: hash, size: data.length }, { status: 201 })
    }
    return new Response(blobs.get(String(input))!.slice().buffer)
  }
  try {
    const a = new ContextVault({ identity, fetch: fetcher, servers: [origin] })
    const view = await a.create({ title: 'Maximum writer', scope: 'personal' }), raw = await a.save()
    expect(bytes(stored(raw).envelope).length).toBe(CONTEXT_ENVELOPE_V2_BYTES)
    const b = new ContextVault({ identity }); await b.restore(raw)
    expect(b.read(view.id)).toEqual(a.read(view.id))
    expect(stored(await b.save()).envelope).toBe(stored(raw).envelope)
    await a.upload(view.id, origin)
    const c = new ContextVault({ identity, fetch: fetcher, servers: [origin] })
    await c.importAccess(await a.access(view.id, identity.pubkey))
    expect(c.read(view.id).head).toBe(view.head)
    expect(stored(await c.save()).envelope).toBe(stored(raw).envelope)
  } finally { identity.dispose() }
})

it('accepts primary extended NIP44 access and self-cache ciphertext beyond the old 65536 limit', async () => {
  const identity = recoveryIdentity({ policyPadding: 70_000 })
  let blob: Uint8Array
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'PUT') {
      blob = new Uint8Array(init.body as ArrayBuffer); const hash = sha256Hex(blob)
      return Response.json({ url: `${origin}/${hash}`, sha256: hash, size: blob.length }, { status: 201 })
    }
    return new Response(blob!.slice().buffer)
  }
  try {
    const a = new ContextVault({ identity, fetch: fetcher, servers: [origin] })
    const view = await a.create({ title: 'Extended cipher', scope: 'personal' })
    const raw = await a.save(), cache = stored(raw)
    expect(JSON.parse(cache.access.content).ciphertext.length).toBeGreaterThan(65536)
    const b = new ContextVault({ identity, fetch: fetcher, servers: [origin] }); await b.restore(raw)
    expect(b.read(view.id).head).toBe(view.head)
    await a.upload(view.id, origin)
    const access = await a.access(view.id, identity.pubkey)
    expect(JSON.parse(access.content).ciphertext.length).toBeGreaterThan(65536)
    await b.previewAccess(access); await b.importAccess(access)
    const damaged = JSON.parse(access.content), binary = bytes(damaged.ciphertext); binary[binary.length - 1]! ^= 1
    damaged.ciphertext = base64(binary)
    await expect(b.previewAccess(finalizeEvent({ ...access, content: JSON.stringify(damaged) }, secret))).rejects.toThrow()
    expect(b.read(view.id).head).toBe(view.head)
  } finally { identity.dispose() }
})

it('restores all 32 collections from an actual writer backup above both old SDK and panel caps', async () => {
  const raw = await aggregateRecoveryFixture(), identity = recoveryIdentity()
  try {
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(90 * 1024 * 1024)
    expect(contextTextFits(raw, CONTEXT_CACHE_BYTES)).toBe(true)
    const a = new ContextVault({ identity }); await a.restore(raw)
    expect(a.list()).toHaveLength(32)
    const resaved = JSON.parse(await a.save())
    expect(resaved.collections.map((r: any) => r.envelope)).toEqual(JSON.parse(raw).collections.map((r: any) => r.envelope))
  } finally { identity.dispose() }
}, 120_000)

it.each(['pointer-max-plus-one', 'envelope-max-plus-one', 'v2-format-cap', 'unknown-magic', 'corrupt-tag', 'wrong-hash', 'wrong-key', 'wrong-head', 'noncanonical-base64', 'cache-MAC', 'cache-version'])('refuses %s without changing the previous collection or source bytes', async fault => {
  const identity = recoveryIdentity({ snapshotCeiling: true })
  try {
    const a = new ContextVault({ identity }), view = await a.create({ title: 'Retained', scope: 'personal' }), raw = await a.save()
    const candidate = JSON.parse(raw), row = candidate.collections[0], envelope = bytes(row.envelope)
    if (fault === 'pointer-max-plus-one') await reseal(identity, row, b => { b.pointer.size = CONTEXT_ENVELOPE_V2_BYTES + 1 })
    if (fault === 'envelope-max-plus-one') row.envelope = base64(new Uint8Array(CONTEXT_ENVELOPE_V2_BYTES + 1))
    if (fault === 'v2-format-cap') {
      // Exact max+1 cannot have valid framing. The smallest 3-record V2
      // frame is max+17: two full chunks, one byte, three tags and header.
      const data = new Uint8Array(CONTEXT_ENVELOPE_V2_BYTES + 17)
      data.set(new TextEncoder().encode('FSWNENC2')); const header = new DataView(data.buffer)
      header.setUint32(8, 1024 * 1024); header.setUint32(12, 3)
      expect(inspectEnvelopeHeader(data).format).toBe('FSWNENC2')
      row.envelope = base64(data)
      // Keep a legal pointer. Its canonical Base64 exceeds the shared V2
      // text cap, so restore refuses before decode, framing or decrypt.
    }
    if (fault === 'unknown-magic' || fault === 'corrupt-tag') {
      envelope[fault === 'unknown-magic' ? 0 : envelope.length - 1]! ^= 1; row.envelope = base64(envelope)
      if (fault === 'corrupt-tag') await reseal(identity, row, b => { b.pointer.sha256 = sha256Hex(envelope); b.pointer.url = `https://local.invalid/${b.pointer.sha256}` })
    }
    if (fault === 'wrong-hash') await reseal(identity, row, b => { b.pointer.sha256 = 'a'.repeat(64); b.pointer.url = `https://local.invalid/${b.pointer.sha256}` })
    if (fault === 'wrong-key') await reseal(identity, row, b => { b.key = 'a'.repeat(64) })
    if (fault === 'wrong-head') await reseal(identity, row, b => { b.head = 'a'.repeat(64) })
    if (fault === 'noncanonical-base64') row.envelope += '\n'
    if (fault === 'cache-MAC' || fault === 'cache-version') {
      const sealed = JSON.parse(row.access.content)
      if (fault === 'cache-version') sealed.v = 2
      else { const binary = bytes(sealed.ciphertext); binary[binary.length - 1]! ^= 1; sealed.ciphertext = base64(binary) }
      row.access = finalizeEvent({ ...row.access, content: JSON.stringify(sealed) }, secret)
    }
    const damaged = JSON.stringify(candidate), before = a.read(view.id)
    await expect(a.restore(damaged)).rejects.toThrow(fault === 'v2-format-cap' ? 'cache is too large' : undefined)
    expect(a.read(view.id)).toEqual(before); expect(JSON.stringify(candidate)).toBe(damaged)
    expect(stored(await a.save()).envelope).toBe(stored(raw).envelope)
  } finally { identity.dispose() }
})

it.each(LEGACY_CONTEXT_CACHES.map((raw, i) => [i, raw] as const))('preserves authenticated historical legacy envelope %s through restore/save', async (_i, raw) => {
  const identity = recoveryIdentity({ secretByte: 9 })
  try {
    const vault = new ContextVault({ identity }); await vault.restore(raw)
    expect(stored(await vault.save()).envelope).toBe(stored(raw).envelope)
  } finally { identity.dispose() }
})

it('owns a signer JSON image so later mutations cannot grow the saved event', async () => {
  const identity = recoveryIdentity(), original = identity.signEvent, signed: any[] = []
  identity.signEvent = async template => { const result = await original(template); signed.push(result); return result }
  try {
    const vault = new ContextVault({ identity }), view = await vault.create({ title: 'Owned event', scope: 'personal' })
    for (const e of signed) e.extra = 'x'.repeat(2 * 1024 * 1024)
    const raw = await vault.save(), restarted = new ContextVault({ identity }); await restarted.restore(raw)
    expect(restarted.read(view.id).head).toBe(view.head)
    expect(inspectEnvelopeHeader(bytes(stored(raw).envelope)).format).toBe('FSWNENC2')
  } finally { identity.dispose() }
})

it.each(['oversize', 'global-cap', 'read-failure'])('cancels %s download streams and retains the previous authenticated state', async fault => {
  const identity = recoveryIdentity()
  let uploaded: Uint8Array, cancelled = 0
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'PUT') {
      uploaded = new Uint8Array(init.body as ArrayBuffer); const hash = sha256Hex(uploaded)
      return Response.json({ url: `${origin}/${hash}`, sha256: hash, size: uploaded.length }, { status: 201 })
    }
    // Reader facade permits observing cancel even for an already errored
    // stream; this test does not claim AbortSignal or live-network acceptance.
    let calls = 0
    return { ok: true, body: { getReader: () => ({
      async read() { calls++; if (fault === 'read-failure') throw Error('Synthetic stream failure')
        return { done: false, value: calls === 1 ? (fault === 'global-cap' ? new Uint8Array(CONTEXT_ENVELOPE_V2_BYTES) : uploaded) : new Uint8Array(1) } },
      async cancel() { cancelled++ },
    }) } } as unknown as Response
  }
  try {
    const vault = new ContextVault({ identity, fetch: fetcher, servers: [origin] })
    const view = await vault.create({ title: 'Retained stream', scope: 'personal' })
    await vault.upload(view.id, origin)
    const before = vault.read(view.id); let access = await vault.access(view.id, identity.pubkey)
    if (fault === 'global-cap') {
      const sealed = JSON.parse(access.content), body = JSON.parse(await identity.decrypt(identity.pubkey, sealed.ciphertext))
      body.pointer.size = CONTEXT_ENVELOPE_V2_BYTES
      sealed.ciphertext = await identity.encrypt(identity.pubkey, JSON.stringify(body))
      access = finalizeEvent({ ...access, content: JSON.stringify(sealed) }, secret)
    }
    await expect(vault.importAccess(access)).rejects.toThrow(fault === 'read-failure' ? 'Synthetic stream failure' : 'exceeded its signed size')
    expect(cancelled).toBe(1); expect(vault.read(view.id)).toEqual(before)
  } finally { identity.dispose() }
})

it.each(['FSWNENC1', 'WBLMENC1'])('keeps the %s passthrough cap smaller than V2 even for valid visible framing', async magic => {
  const identity = recoveryIdentity({ snapshotCeiling: true })
  try {
    const vault = new ContextVault({ identity }), view = await vault.create({ title: 'Legacy cap', scope: 'personal' }), raw = await vault.save()
    const candidate = JSON.parse(raw), row = candidate.collections[0]
    const envelope = new Uint8Array(2 * 1024 * 1024 + 56)
    envelope.set(new TextEncoder().encode(magic)); const header = new DataView(envelope.buffer)
    header.setUint32(8, 1024 * 1024); header.setUint32(12, 2)
    // Framing fixture only; authenticated primary historical-writer evidence
    // is retained separately. No handmade ciphertext-authentication claim.
    expect(inspectEnvelopeHeader(envelope).format).toBe(magic)
    row.envelope = base64(envelope)
    await reseal(identity, row, b => { b.pointer.size = envelope.length; b.pointer.sha256 = sha256Hex(envelope); b.pointer.url = `https://local.invalid/${b.pointer.sha256}` })
    await expect(vault.restore(JSON.stringify(candidate))).rejects.toThrow('envelope')
    expect(vault.read(view.id).head).toBe(view.head)
  } finally { identity.dispose() }
})
