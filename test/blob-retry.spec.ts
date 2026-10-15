import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

// Actual writer and retry module, native Storage/fetch and mocked HTTPS
// Blossom responses. No real remote deletion, handset or authority proof.
const origin = 'https://blob-retry.kithmoot.test', targetOrigin = 'https://files.example:8443'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./blob-retry.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Retry', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
test.beforeEach(async ({ context, page }) => {
  await context.route('**/*', route => {
    const req = route.request()
    if (req.url().startsWith(origin + '/')) return route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' })
    // Every other request is mocked; an unexpected host cannot reach a real
    // operator. Counts below include preflights, DELETEs and HEADs.
    return route.abort()
  })
  await page.goto(origin)
  await page.evaluate(`(async()=>{
    window.now=1800000000;window.hash='ab'.repeat(32);window.url='${targetOrigin}/blossom/'+hash;window.sk=new Uint8Array(32).fill(7)
    window.store=Retry.browserDeviceStore(localStorage)
    await Retry.deleteUploads({blobs:[{url,sha256:hash}],origins:['${targetOrigin}'],sk,now:()=>now,store,
      fetch:async()=>{throw TypeError('Synthetic offline')}})
    window.before=localStorage.getItem(Retry.PENDING_BLOB_DELETES_KEY)
    window.countWrites=()=>{window.writes=0;window.removes=0;const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
      Storage.prototype.setItem=function(...a){writes++;return set.apply(this,a)};Storage.prototype.removeItem=function(...a){removes++;return remove.apply(this,a)}}
  })()`)
})

for (const fault of ['host', 'port', 'path', 'legacy', 'duplicate-binding', 'mixed-malformed', 'bad-signature', 'expired-legacy', 'noncanonical'])
  test(`native startup retry holds ${fault} bytes before any native fetch or Storage mutation`, async ({ page }) => {
    const requests: string[] = []; page.on('request', r => requests.push(r.url()))
    expect(await page.evaluate(`(async()=>{const rows=JSON.parse(before),p=rows[0];
      const fault='${fault}';if(fault==='host')p.url=p.url.replace('files.example','other.example');
      if(fault==='port')p.url=p.url.replace(':8443',':9443');if(fault==='path')p.url=p.url.replace('/blossom/','/other/');
      if(fault==='legacy'||fault==='expired-legacy')p.auth.tags.pop();
      if(fault==='duplicate-binding')p.auth.tags.push(p.auth.tags.at(-1));
      if(fault==='legacy'||fault==='expired-legacy'||fault==='duplicate-binding')p.auth=Retry.finalizeEvent(p.auth,sk);
      if(fault==='mixed-malformed')rows.push({url:'bad'});if(fault==='bad-signature')p.auth.sig='0'.repeat(128);
      const raw=JSON.stringify(rows)+(fault==='noncanonical'?' ':'');localStorage.setItem(Retry.PENDING_BLOB_DELETES_KEY,raw);countWrites();
      let held=false;try{await Retry.retryPendingBlobDeletes(store,()=>now+(fault==='expired-legacy'?604800:0))}catch(e){held=e.message.includes('journal was retained')}
      return[held,writes,removes,localStorage.getItem(Retry.PENDING_BLOB_DELETES_KEY)===raw]})()`)).toEqual([true, 0, 0, true])
    expect(requests).toEqual([])
  })

for (const head of ['absent', 'network-failure', 'kept'] as const) test(`native bound retry ${head} preserves the correct journal outcome`, async ({ context, page }) => {
  const calls: { method: string; auth?: any }[] = []
  await context.route(targetOrigin + '/**', async route => {
    const req = route.request(), method = req.method()
    const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'DELETE,HEAD,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Max-Age': '0' }
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const auth = req.headers().authorization
    calls.push({ method, ...(auth ? { auth: JSON.parse(Buffer.from(auth.slice(6), 'base64').toString('utf8')) } : {}) })
    if (method === 'HEAD' && head === 'network-failure') return route.abort()
    return route.fulfill({ status: method === 'HEAD' && head === 'absent' ? 404 : 200, headers })
  })
  const result = await page.evaluate<{ remaining: number; retained: boolean; absent: boolean }>(`(async()=>{
    const remaining=await Retry.retryPendingBlobDeletes(store,()=>now+1);const after=localStorage.getItem(Retry.PENDING_BLOB_DELETES_KEY);
    return{remaining,retained:after===before,absent:after===null}})()`)
  expect(result).toEqual(head === 'absent' ? { remaining: 0, retained: false, absent: true } : { remaining: 1, retained: true, absent: false })
  expect(calls.map(c => c.method)).toEqual(['DELETE', 'HEAD'])
  expect(calls[0]!.auth.tags).toContainEqual(['kithmoot-delete-target-v1', targetOrigin + '/blossom/' + 'ab'.repeat(32)])
  expect(calls[1]!.auth).toBeUndefined()
})

test('native retained journal survives reload and legacy HOLD does not replace its bytes', async ({ page }) => {
  const raw = await page.evaluate<string>('before')
  await page.reload()
  expect(await page.evaluate<string>(`localStorage.getItem(Retry.PENDING_BLOB_DELETES_KEY)`)).toBe(raw)
  expect(await page.evaluate(`(async()=>{const raw=localStorage.getItem(Retry.PENDING_BLOB_DELETES_KEY),rows=JSON.parse(raw);
    rows[0].auth.tags.pop();rows[0].auth=Retry.finalizeEvent(rows[0].auth,new Uint8Array(32).fill(7));const legacy=JSON.stringify(rows);
    localStorage.setItem(Retry.PENDING_BLOB_DELETES_KEY,legacy);let held=false;
    try{await Retry.retryPendingBlobDeletes(Retry.browserDeviceStore(localStorage),()=>1800000001)}catch(e){held=true}
    return[held,localStorage.getItem(Retry.PENDING_BLOB_DELETES_KEY)===legacy]})()`)).toEqual([true, true])
})

for (const failure of ['quota', 'ignored-write']) test(`native preparation ${failure} stops before native network effects`, async ({ page }) => {
  const requests: string[] = []; page.on('request', r => requests.push(r.url()))
  expect(await page.evaluate(`(async()=>{localStorage.removeItem(Retry.PENDING_BLOB_DELETES_KEY);countWrites();
    Storage.prototype.setItem=function(){writes++;${failure === 'quota' ? "throw new DOMException('Synthetic quota','QuotaExceededError')" : ''}};
    let held=false;try{await Retry.deleteUploads({blobs:[{url,sha256:hash}],origins:['${targetOrigin}'],sk,now:()=>now,store})}catch(e){held=true}
    return[held,writes,removes,localStorage.getItem(Retry.PENDING_BLOB_DELETES_KEY)]})()`)).toEqual([true,1,0,null])
  expect(requests).toEqual([])
})
test('native unsigned upload record cannot authorise an old operator', async ({ page }) => {
  const requests: string[] = []; page.on('request', r => requests.push(r.url()))
  expect(await page.evaluate(`(async()=>{countWrites();const report=await Retry.deleteUploads({blobs:[{url,sha256:hash}],origins:[],sk,now:()=>now,store});
    return[report.refused,writes,removes,localStorage.getItem(Retry.PENDING_BLOB_DELETES_KEY)===before]})()`)).toEqual([1,0,0,true])
  expect(requests).toEqual([])
})
