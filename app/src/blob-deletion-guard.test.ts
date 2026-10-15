import { expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { buildDeleteAuthorisation, deleteBlob, isDeleteAuthorisationTarget } from '../../src/attachment.js'
import { memoryDeviceStore } from './device-store.js'
import { BLOB_DELETE_RETRY_SECONDS, PENDING_BLOB_DELETES_KEY, deleteUploads, pendingBlobDeletes, uploadsFromEvents, readPendingBlobDeleteJournal, retryPendingBlobDeletes } from './blob-deletion.js'

const now = 1_800_000_000, hash = 'ab'.repeat(32), origin = 'https://files.example:8443'
const url = `${origin}/blossom/${hash}`, sk = new Uint8Array(32).fill(7)
async function fixture() {
  const store = memoryDeviceStore()
  await deleteUploads({ blobs: [{ url, sha256: hash }], origins: [origin], sk, now: () => now, store,
    fetch: async () => { throw TypeError('Synthetic offline server') } })
  return { store, raw: store.get(PENDING_BLOB_DELETES_KEY)!, rows: JSON.parse(store.get(PENDING_BLOB_DELETES_KEY)!) }
}
const resign = (row: any) => { row.auth = finalizeEvent(row.auth, sk) }

it('the actual failed-upload deletion writer signs the exact port and path and is parsed without a clock', async () => {
  const f = await fixture(), row = f.rows[0]
  expect(row.auth.tags.at(-1)).toEqual(['kithmoot-delete-target-v1', url])
  expect(row.until).toBe(now + BLOB_DELETE_RETRY_SECONDS)
  expect(isDeleteAuthorisationTarget(row.auth, hash, url)).toBe(true)
  expect(readPendingBlobDeleteJournal(f.raw)).toEqual(f.rows)
  expect(f.store.get(PENDING_BLOB_DELETES_KEY)).toBe(f.raw)
})

const faults = ['host', 'port', 'path', 'http', 'credentials', 'query', 'fragment', 'hash-leaf', 'upper-hash',
  'missing-binding', 'duplicate-binding', 'wrong-binding', 'duplicate-server', 'wrong-server', 'duplicate-x', 'wrong-x',
  'duplicate-expiration', 'wrong-until', 'noninteger-until', 'wrong-lifetime', 'signature', 'malformed-row',
  'mixed-malformed', 'noncanonical', 'empty', 'over-count', 'row-extra', 'auth-extra', 'oversize-raw', 'duplicate-url'] as const
it.each(faults)('holds the entire %s journal byte-exactly before any request or mutation', async fault => {
  const f = await fixture(), p = f.rows[0]
  if (fault === 'host') p.url = `https://other.example/blossom/${hash}`
  if (fault === 'port') p.url = `https://files.example:9443/blossom/${hash}`
  if (fault === 'path') p.url = `${origin}/other/${hash}`
  if (fault === 'http') p.url = url.replace('https:', 'http:')
  if (fault === 'credentials') p.url = url.replace('https://', 'https://user:password@')
  if (fault === 'query') p.url += '?redirect=elsewhere'
  if (fault === 'fragment') p.url += '#fragment'
  if (fault === 'hash-leaf') p.url = `${origin}/blossom/${'cd'.repeat(32)}`
  if (fault === 'upper-hash') p.sha256 = hash.toUpperCase()
  if (fault === 'missing-binding') p.auth.tags.pop()
  if (fault === 'duplicate-binding') p.auth.tags.push(p.auth.tags.at(-1))
  if (fault === 'wrong-binding') p.auth.tags.at(-1)[1] = `${origin}/other/${hash}`
  if (fault === 'duplicate-server') p.auth.tags.push(['server', 'files.example'])
  if (fault === 'wrong-server') p.auth.tags.find((t: string[]) => t[0] === 'server')[1] = 'other.example'
  if (fault === 'duplicate-x') p.auth.tags.push(['x', hash])
  if (fault === 'wrong-x') p.auth.tags.find((t: string[]) => t[0] === 'x')[1] = 'cd'.repeat(32)
  if (fault === 'duplicate-expiration') p.auth.tags.push(p.auth.tags.find((t: string[]) => t[0] === 'expiration'))
  if (fault === 'wrong-until') p.until++
  if (fault === 'noninteger-until') p.until += 0.5
  if (fault === 'wrong-lifetime') { p.until++; p.auth.tags.find((t: string[]) => t[0] === 'expiration')[1] = String(p.until) }
  if (fault === 'signature') p.auth.sig = '0'.repeat(128)
  else if (['missing-binding', 'duplicate-binding', 'wrong-binding', 'duplicate-server', 'wrong-server', 'duplicate-x',
    'wrong-x', 'duplicate-expiration', 'wrong-lifetime'].includes(fault)) resign(p)
  if (fault === 'malformed-row') f.rows[0] = null
  if (fault === 'mixed-malformed') f.rows.push({ url: 'bad' })
  if (fault === 'empty') f.rows.length = 0
  if (fault === 'over-count') f.rows.push(...Array(2000).fill(p))
  if (fault === 'duplicate-url') f.rows.push(structuredClone(p))
  if (fault === 'row-extra') p.privateMetadata = 'retained, never sent'
  if (fault === 'auth-extra') p.auth.privateMetadata = 'must not leak in header'
  const raw = JSON.stringify(f.rows) + (fault === 'noncanonical' ? ' ' : fault === 'oversize-raw' ? ' '.repeat(8 * 1024 * 1024) : '')
  f.store.set(PENDING_BLOB_DELETES_KEY, raw)
  expect(() => pendingBlobDeletes(f.store, now)).toThrow('journal was retained')
  const set = vi.spyOn(f.store, 'set'), remove = vi.spyOn(f.store, 'remove'), fetcher = vi.fn(async () => new Response(null, { status: 404 }))
  await expect(retryPendingBlobDeletes(f.store, () => now, { fetch: fetcher })).rejects.toThrow('journal was retained')
  expect(fetcher).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
  expect(f.store.get(PENDING_BLOB_DELETES_KEY)).toBe(raw)
  // A new tidy-up must not filter damaged history into a successful write.
  await expect(deleteUploads({ blobs: [{ url, sha256: hash }], origins: [origin], sk, now: () => now, store: f.store, fetch: fetcher })).rejects.toThrow('journal was retained')
  expect(fetcher).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
})

for (const status of [200, 204, 404]) for (const failure of ['network', 'abort'])
  it(`keeps the exact signed target after DELETE ${status} and HEAD ${failure}`, async () => {
    const f = await fixture(), fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') throw failure === 'abort' ? new DOMException('Synthetic abort', 'AbortError') : TypeError('Synthetic offline')
      return new Response(null, { status })
    }) as unknown as typeof fetch
    expect(await retryPendingBlobDeletes(f.store, () => now + 1, { fetch: fetcher })).toBe(1)
    expect(f.store.get(PENDING_BLOB_DELETES_KEY)).toBe(f.raw)
  })

it.each([404, 410])('removes a valid pending target only after HEAD %s proves absence at that response', async status => {
  const f = await fixture(), calls: string[] = []
  expect(await retryPendingBlobDeletes(f.store, () => now + 1, { fetch: async (_url, init) => {
    calls.push(init!.method!); return new Response(null, { status: init?.method === 'DELETE' ? 200 : status })
  } })).toBe(0)
  expect(calls).toEqual(['DELETE', 'HEAD']); expect(f.store.get(PENDING_BLOB_DELETES_KEY)).toBeNull()
})

it('does not discard a replaced same-URL authorisation while an older request is in flight', async () => {
  const f = await fixture(), replacement = structuredClone(f.rows[0])
  replacement.auth = finalizeEvent(buildDeleteAuthorisation(hash, origin, now + 10, BLOB_DELETE_RETRY_SECONDS + 1, url), sk)
  replacement.until = Number(replacement.auth.tags.find((t: string[]) => t[0] === 'expiration')[1])
  const raw = JSON.stringify([replacement])
  expect(await retryPendingBlobDeletes(f.store, () => now + 20, { fetch: async (_url, init) => {
    if (init?.method === 'DELETE') { f.store.set(PENDING_BLOB_DELETES_KEY, raw); return new Response(null, { status: 200 }) }
    return new Response(null, { status: 404 })
  } })).toBe(1)
  expect(f.store.get(PENDING_BLOB_DELETES_KEY)).toBe(raw)
})

it('prunes only authenticated expired rows and refuses an invalid retry clock', async () => {
  const f = await fixture(), fetcher = vi.fn(async () => new Response(null, { status: 404 }))
  await expect(retryPendingBlobDeletes(f.store, () => NaN, { fetch: fetcher })).rejects.toThrow('valid clock')
  expect(f.store.get(PENDING_BLOB_DELETES_KEY)).toBe(f.raw)
  expect(await retryPendingBlobDeletes(f.store, () => now + BLOB_DELETE_RETRY_SECONDS, { fetch: fetcher })).toBe(0)
  expect(fetcher).not.toHaveBeenCalled(); expect(f.store.get(PENDING_BLOB_DELETES_KEY)).toBeNull()
})

it.each([null, {}, { tags: null }, { tags: [null] }])('direct delete refuses malformed authorisations without throwing or fetching (%#)', async candidate => {
  const fetcher = vi.fn(async () => new Response(null, { status: 404 }))
  expect((await deleteBlob(url, candidate as any, { fetch: fetcher })).status).toBe('failed')
  expect(fetcher).not.toHaveBeenCalled()
})

it('holds a full journal before new deletion effects instead of evicting retained entries', async () => {
  const f = await fixture(), raw = JSON.stringify(Array.from({length: 2000}, (_, i) => {
    const sha256 = i.toString(16).padStart(64, '0'), target = `${origin}/blossom/${sha256}`
    const auth = finalizeEvent(buildDeleteAuthorisation(sha256, origin, now, BLOB_DELETE_RETRY_SECONDS + 1, target), sk)
    return {url: target, sha256, auth, until: now + BLOB_DELETE_RETRY_SECONDS}
  }))
  f.store.set(PENDING_BLOB_DELETES_KEY, raw)
  const fetcher = vi.fn(async () => new Response(null, { status: 404 })), set = vi.spyOn(f.store, 'set')
  await expect(deleteUploads({ blobs: [{ url: `${origin}/${'cd'.repeat(32)}`, sha256: 'cd'.repeat(32) }], origins: [origin], sk,
    now: () => now, store: f.store, fetch: fetcher })).rejects.toThrow('journal is full')
  expect(fetcher).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(f.store.get(PENDING_BLOB_DELETES_KEY)).toBe(raw)
}, 30_000)

it('reports a failed persistence rather than claiming that a retry was saved', async () => {
  const fetcher = vi.fn(async () => new Response(null, {status: 404}))
  const store = memoryDeviceStore(); vi.spyOn(store, 'set').mockImplementation(() => { throw Error('Synthetic quota failure') })
  await expect(deleteUploads({ blobs: [{ url, sha256: hash }], origins: [origin], sk, now: () => now, store,
    fetch: fetcher })).rejects.toThrow('Synthetic quota failure')
  expect(fetcher).not.toHaveBeenCalled()
})

const announcement = (key = sk, target = url, sha256 = hash) => finalizeEvent({kind: 1063, created_at: now, content: '', tags: [['url', target], ['x', sha256]]}, key)
it('an unsigned old-operator upload is refused without contact or persistence', async () => {
  const store = memoryDeviceStore(), fetcher = vi.fn(async () => new Response(null, {status: 404}))
  expect(await deleteUploads({blobs: [{url, sha256: hash}], origins: ['https://current.example'], sk, now: () => now, store, fetch: fetcher}))
    .toEqual({found: 1, deleted: 0, refused: 1, pending: 0, details: []})
  expect(fetcher).not.toHaveBeenCalled(); expect(store.keys()).toEqual([])
})
it.each(['valid', 'forged', 'wrong-device', 'duplicate-url-tag', 'wrong-hash', 'other-path'] as const)('historical %s announcement grants only exact verified own-device target provenance', async kind => {
  let auth = announcement(kind === 'wrong-device' ? new Uint8Array(32).fill(8) : sk,
    kind === 'other-path' ? `${origin}/other/${hash}` : url, kind === 'wrong-hash' ? 'cd'.repeat(32) : hash)
  if (kind === 'forged') auth.content = 'tampered after signature verification cache was set'
  if (kind === 'duplicate-url-tag') auth = finalizeEvent({...auth, tags: [...auth.tags, ['url', url]]}, sk)
  const store = memoryDeviceStore(), requests: string[] = []
  const report = await deleteUploads({blobs: [{url, sha256: hash}], origins: [], signedUploads: [auth], sk, now: () => now, store,
    fetch: async (_url, init) => {requests.push(init!.method!);return new Response(null, {status: 404})}})
  expect(report.deleted).toBe(kind === 'valid' ? 1 : 0)
  expect(report.refused).toBe(kind === 'valid' ? 0 : 1)
  expect(requests).toEqual(kind === 'valid' ? ['DELETE', 'HEAD'] : [])
  if (kind !== 'valid' && kind !== 'other-path') expect(uploadsFromEvents([auth], getPublicKey(sk))).toEqual([])
})
it('verified historical provenance cannot promote another unsigned path on the same origin', async () => {
  const store = memoryDeviceStore(), calls: string[] = []
  const report = await deleteUploads({blobs: [{url, sha256: hash}, {url: `${origin}/other/${hash}`, sha256: hash}], origins: [],
    signedUploads: [announcement()], sk, now: () => now, store, fetch: async target => {calls.push(String(target));return new Response(null,{status:404})}})
  expect(report).toMatchObject({found: 2, deleted: 1, refused: 1})
  expect(calls).toEqual([url, url])
})
it('sends only the exact permission durably read back before the first request', async () => {
  const store = memoryDeviceStore(), sent: string[] = []
  await deleteUploads({blobs: [{url, sha256: hash}], origins: [origin], sk, now: () => now, store, fetch: async (_url, init) => {
    const rows = readPendingBlobDeleteJournal(store.get(PENDING_BLOB_DELETES_KEY))
    expect(rows).toHaveLength(1)
    if (init?.method === 'DELETE') {
      const auth = JSON.parse(Buffer.from((init.headers as Record<string,string>).Authorization!.slice(6), 'base64').toString())
      expect(auth).toEqual(rows[0]!.auth); sent.push('persisted exact permission')
    }
    return new Response(null,{status:404})
  }})
  expect(sent).toEqual(['persisted exact permission']); expect(store.get(PENDING_BLOB_DELETES_KEY)).toBeNull()
})
it('a silently ignored persistence write stops before any request', async () => {
  const store = memoryDeviceStore(), fetcher = vi.fn(async () => new Response(null,{status:404}))
  vi.spyOn(store,'set').mockImplementation(() => {})
  await expect(deleteUploads({blobs: [{url,sha256:hash}],origins:[origin],sk,now:()=>now,store,fetch:fetcher})).rejects.toThrow('saved and verified')
  expect(fetcher).not.toHaveBeenCalled()
})
it('the actual serialized journal byte ceiling is reserved before writing or sending', async () => {
  const store = memoryDeviceStore(), fetcher = vi.fn(async () => new Response(null,{status:404})), set = vi.spyOn(store,'set')
  const longUrl = `${origin}/${'x'.repeat(5 * 1024 * 1024)}/${hash}`
  await expect(deleteUploads({blobs: [{url:longUrl,sha256:hash}],origins:[origin],sk,now:()=>now,store,fetch:fetcher})).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled()
}, 30_000)
it('initial deletion cleanup retains a same-URL permission replaced during the request', async () => {
  const store = memoryDeviceStore()
  const auth = finalizeEvent(buildDeleteAuthorisation(hash,origin,now+10,BLOB_DELETE_RETRY_SECONDS+1,url),sk)
  const raw = JSON.stringify([{url,sha256:hash,auth,until:now+10+BLOB_DELETE_RETRY_SECONDS}])
  await deleteUploads({blobs:[{url,sha256:hash}],origins:[origin],sk,now:()=>now,store,fetch:async (_url,init)=>{
    if(init?.method==='DELETE')store.set(PENDING_BLOB_DELETES_KEY,raw)
    return new Response(null,{status:404})
  }})
  expect(store.get(PENDING_BLOB_DELETES_KEY)).toBe(raw)
})
it('refuses to overwrite another uploader’s retained permission for the same URL', async () => {
  const f = await fixture(), fetcher = vi.fn(async()=>new Response(null,{status:404}))
  await expect(deleteUploads({blobs:[{url,sha256:hash}],origins:[origin],sk:new Uint8Array(32).fill(8),now:()=>now,store:f.store,fetch:fetcher})).rejects.toThrow('different retained uploader')
  expect(fetcher).not.toHaveBeenCalled();expect(f.store.get(PENDING_BLOB_DELETES_KEY)).toBe(f.raw)
})
it('the t=0 writer copies the clamped signed expiry and remains parseable', async () => {
  const store = memoryDeviceStore()
  await deleteUploads({blobs:[{url,sha256:hash}],origins:[origin],sk,now:()=>0,store,fetch:async()=>{throw TypeError('Synthetic offline')}})
  expect(readPendingBlobDeleteJournal(store.get(PENDING_BLOB_DELETES_KEY))[0]!.until).toBe(BLOB_DELETE_RETRY_SECONDS+1)
})
it.each([NaN, -1, Number.MAX_SAFE_INTEGER])('invalid or overflowing initial clock %s cannot write or send', async clock => {
  const store = memoryDeviceStore(), fetcher = vi.fn(async()=>new Response(null,{status:404}))
  await expect(deleteUploads({blobs:[{url,sha256:hash}],origins:[origin],sk,now:()=>clock,store,fetch:fetcher})).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled();expect(store.keys()).toEqual([])
})

it('counts canonical aliases as one file and sends one DELETE with accurate completion', async () => {
  const store = memoryDeviceStore(), calls: string[] = []
  const report = await deleteUploads({blobs:[{url:`${url}.txt`,sha256:hash},{url,sha256:hash}],origins:[origin],sk,now:()=>now,store,
    fetch:async (_url,init)=>{calls.push(init!.method!);return new Response(null,{status:404})}})
  expect(report).toEqual({found:1,deleted:1,refused:0,pending:0,details:[]})
  expect(calls).toEqual(['DELETE','HEAD']);expect(store.get(PENDING_BLOB_DELETES_KEY)).toBeNull()
})
