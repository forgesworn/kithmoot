import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

const origin = 'https://context-recovery.kithmoot.test'
let html = ''
test.beforeAll(async () => {
  const source = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8')
  const dialog = source.match(/<dialog id="contextPanel"[\s\S]*?<\/dialog>/)![0]
  const bundle = (await build({ entryPoints: [fileURLToPath(new URL('./context-recovery.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Recovery', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
  html = '<!doctype html><meta charset="utf-8">' + dialog + '<script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>'
})
test.beforeEach(async ({ page }) => {
  await page.route(origin + '/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }))
  await page.goto(origin)
  await page.evaluate(`(async()=>{
    // Explicit in-memory adapter avoids a false native localStorage quota
    // claim for this 91MiB panel fixture. Actual component/file/crypto run.
    window.saved=null;window.writes=0;window.textReads=0
    Storage.prototype.getItem=function(){return saved};Storage.prototype.setItem=function(k,v){saved=v;writes++}
    const read=File.prototype.text;File.prototype.text=function(){textReads++;return read.call(this)}
    window.identity=Recovery.recoveryIdentity()
    window.panel=new Recovery.ContextPanel(document,{identity:()=>identity,room:()=>undefined,server:()=>'',members:()=>[]})
    window.setFile=file=>{const dt=new DataTransfer();dt.items.add(file);document.getElementById('contextFile').files=dt.files}
    await panel.open()
  })()`)
  await page.getByText('Import or back up context', { exact: true }).click()
})

test('actual ContextPanel restores a real >90MiB SDK writer File with an explicit Storage adapter', async ({ page }) => {
  const result = await page.evaluate<{ bytes: number; cap: number }>(`(async()=>{
    let raw=await Recovery.aggregateRecoveryFixture();const file=new File([raw],'synthetic-context-backup.json',{type:'application/json'})
    const n=file.size;raw=null;setFile(file)
    return {bytes:n,cap:Recovery.CONTEXT_CACHE_BYTES}
  })()`)
  expect(result.bytes).toBeGreaterThan(90 * 1024 * 1024); expect(result.bytes).toBeLessThanOrEqual(result.cap)
  await page.locator('#contextRestore').click()
  await expect(page.locator('#contextStatus')).toHaveText('Encrypted backup restored for this identity.', { timeout: 90_000 })
  expect(await page.evaluate(`({collections:document.getElementById('contextCollection').options.length,textReads,writes,
    savedCollections:JSON.parse(saved).collections.length})`)).toEqual({ collections: 32, textReads: 1, writes: 1, savedCollections: 32 })
})

for (const [button, cap, message] of [
  ['contextRestore', 'CONTEXT_CACHE_BYTES', 'Backup is too large. Close and reopen context before continuing.'],
  ['contextPreview', 'CONTEXT_EVENT_BYTES', 'Access file is too large.'],
] as const) test(`actual panel ${button} refuses declared cap+1 before File.text`, async ({ page }) => {
  // A declared-size fault fixture covers the early gate without allocating
  // an unrelated 117MiB+1 buffer. The accepted test above uses actual bytes.
  await page.evaluate(`(()=>{const file=new File(['{}'],'oversize-declared.json');
    // WebKit rewraps Files when assigning a DataTransfer FileList, so put
    // this explicit fault's declared-size accessor on the File prototype.
    const size=Object.getOwnPropertyDescriptor(Blob.prototype,'size').get;
    Object.defineProperty(File.prototype,'size',{get(){return this.name==='oversize-declared.json'?Recovery.${cap}+1:size.call(this)}});
    File.prototype.text=function(){textReads++;throw Error('Must reject before text')};setFile(file)})()`)
  await page.locator('#' + button).click()
  await expect(page.locator('#contextStatus')).toHaveText(message)
  expect(await page.evaluate('({textReads,writes,saved})')).toEqual({ textReads: 0, writes: 0, saved: null })
})
