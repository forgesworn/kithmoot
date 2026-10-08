import { build } from 'esbuild'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://vault.kithmoot.test'
let bundle = ''

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('./mls-vault.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'V', platform: 'browser', write: false, target: 'es2022',
  })
  bundle = out.outputFiles[0]!.text
})

async function serve(context: BrowserContext): Promise<void> {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({
    status: 200, contentType: 'text/html',
    body: `<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`,
  }))
}

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/`)
  return page
}

// Runs in the page: a vault for a persona whose identity secret is `secretHex`.
const setup = `
  (secretHex) => {
    const secret = V.hexToBytes(secretHex)
    const persona = V.getPublicKey(secret)
    const signed = []
    const identity = { pubkey: persona, signEvent: async e => { const s = V.finalizeEvent(e, secret); signed.push(s); return s } }
    const vault = new V.MlsVault(new V.BrowserMlsVaultStorage())
    window.t = { vault, identity, persona, signed, ctx: () => vault.context('${ORIGIN}', persona) }
  }`

test('enrols, persists across a reload, keeps its keys non-extractable and replays from the journal', async ({ browser }) => {
  const context = await browser.newContext()
  await serve(context)
  const page = await open(context)
  const secret = await page.evaluate(() => V.bytesToHex(V.generateSecretKey()))
  await page.evaluate(`(${setup})('${secret}')`)
  const first = await page.evaluate(async () => {
    const now = Math.floor(Date.now() / 1000)
    const enrolled = await t.vault.enrol(t.ctx(), t.identity, now + 86_400)
    if (!enrolled.ok) throw new Error(enrolled.refusal)
    const body = V.encodeUnsignedBinding({
      leafId: V.randomBytes(32), signatureKey: V.randomBytes(32), credential: t.signed[0],
      device: enrolled.value.device, expiresAt: now + 3600, homeBox: V.randomBytes(32),
    })
    const request = { v: 1, operation: V.bytesToHex(V.randomBytes(32)), body: V.base64Encode(body), digest: V.bytesToHex(V.bindingDigest(body)), expires_at: now + 300 }
    const result = await t.vault.signLeafBindingV1(t.ctx(), request, async () => 'approve')
    if (!result.ok) throw new Error(result.refusal)
    return { request, signature: result.value.signature, device: enrolled.value.device }
  })
  const keys = await page.evaluate(() => new Promise<boolean[]>((resolve, reject) => {
    const open = indexedDB.open('kithmoot-mls-vault-v1')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const get = open.result.transaction('keys').objectStore('keys').get('vault')
      get.onsuccess = () => resolve([get.result.seal.extractable, get.result.name.extractable])
    }
  }))
  expect(keys).toEqual([false, false])

  await page.reload()
  await page.evaluate(`(${setup})('${secret}')`)
  const after = await page.evaluate(async (first) => {
    const device = await t.vault.device(t.ctx())
    const again = await t.vault.signLeafBindingV1(t.ctx(), first.request, async () => 'deny')
    return { device: device.ok ? device.value.device : device.refusal, signature: again.ok ? again.value.signature : again.refusal }
  }, first)
  expect(after).toEqual({ device: first.device, signature: first.signature })
  await context.close()
})

test('two tabs asking for the same operation at once both get its one signature', async ({ browser }) => {
  const context = await browser.newContext()
  await serve(context)
  const a = await open(context)
  const b = await open(context)
  const secret = await a.evaluate(() => V.bytesToHex(V.generateSecretKey()))
  await a.evaluate(`(${setup})('${secret}')`)
  await b.evaluate(`(${setup})('${secret}')`)
  const request = await a.evaluate(async () => {
    const now = Math.floor(Date.now() / 1000)
    const enrolled = await t.vault.enrol(t.ctx(), t.identity, now + 86_400)
    if (!enrolled.ok) throw new Error(enrolled.refusal)
    const box = V.randomBytes(32)
    await t.vault.approve(t.ctx(), { principal: location.origin, persona: t.persona, device: enrolled.value.device, homeBox: V.bytesToHex(box), method: V.SIGN_METHOD })
    const body = V.encodeUnsignedBinding({
      leafId: V.randomBytes(32), signatureKey: V.randomBytes(32), credential: t.signed[0],
      device: enrolled.value.device, expiresAt: now + 3600, homeBox: box,
    })
    return { v: 1, operation: V.bytesToHex(V.randomBytes(32)), body: V.base64Encode(body), digest: V.bytesToHex(V.bindingDigest(body)), expires_at: now + 300 }
  })
  const sign = (page: Page) => page.evaluate(async (request) => {
    const result = await t.vault.signLeafBindingV1(t.ctx(), request, async () => 'deny')
    return result.ok ? result.value.signature : result.refusal
  }, request)
  // Both at once, several times over: BIP-340 signing here is randomised, so
  // two writers would show as two different signatures.
  for (let round = 0; round < 3; round++) {
    const [x, y] = await Promise.all([sign(a), sign(b)])
    expect(x).toMatch(/^[0-9a-f]{128}$/)
    expect(y).toBe(x)
  }
  await context.close()
})

test('S24: a write waits while another tab holds the vault lock', async ({ browser }) => {
  const context = await browser.newContext()
  await serve(context)
  const a = await open(context)
  const b = await open(context)
  const secret = await a.evaluate(() => V.bytesToHex(V.generateSecretKey()))
  await a.evaluate(`(${setup})('${secret}')`)
  await b.evaluate(`(${setup})('${secret}')`)
  // Tab A makes the vault's keys and installation, then holds its lock.
  await a.evaluate(async () => {
    await t.vault.device(t.ctx())
    await new Promise<void>(held => {
      navigator.locks.request('kithmoot-mls-vault-v1', () => new Promise<void>(release => { held(); (window as any).release = release }))
    })
  })
  // Tab B's enrolment writes under the same lock, so it cannot finish yet.
  await b.evaluate(() => {
    (window as any).done = false
    t.vault.enrol(t.ctx(), t.identity, Math.floor(Date.now() / 1000) + 86_400).then((r: { ok: boolean }) => { (window as any).done = r.ok })
  })
  await b.waitForTimeout(500)
  expect(await b.evaluate(() => (window as any).done)).toBe(false)
  await a.evaluate(() => (window as any).release())
  await expect.poll(() => b.evaluate(() => (window as any).done)).toBe(true)
  await context.close()
})

for (const change of ['clear', 'replace'] as const) {
  for (const decision of ['approve', 'deny'] as const) {
    test(`K2: ${change} in another tab fences pending ${decision} and an earlier reply`, async ({ browser }) => {
      const context = await browser.newContext()
      await serve(context)
      const a = await open(context)
      const b = await open(context)
      const secret = await a.evaluate(() => V.bytesToHex(V.generateSecretKey()))
      await a.evaluate(`(${setup})('${secret}')`)
      await b.evaluate(`(${setup})('${secret}')`)
      const requests = await a.evaluate(async () => {
        const now = Math.floor(Date.now() / 1000)
        const enrolled = await t.vault.enrol(t.ctx(), t.identity, now + 86_400)
        if (!enrolled.ok) throw new Error(enrolled.refusal)
        return [0, 1].map(() => {
          const body = V.encodeUnsignedBinding({
            leafId: V.randomBytes(32), signatureKey: V.randomBytes(32), credential: t.signed[0],
            device: enrolled.value.device, expiresAt: now + 3600, homeBox: V.randomBytes(32),
          })
          return { v: 1, operation: V.bytesToHex(V.randomBytes(32)), body: V.base64Encode(body), digest: V.bytesToHex(V.bindingDigest(body)), expires_at: now + 300 }
        })
      })
      await b.evaluate(async requests => {
        t.oldContext = t.ctx()
        t.earlier = await t.vault.signLeafBindingV1(t.oldContext, requests[0], async () => 'approve')
        if (!t.earlier.ok) throw new Error(t.earlier.refusal)
        t.pending = t.vault.signLeafBindingV1(t.oldContext, requests[1], () => new Promise(resolve => { t.decide = resolve }))
      }, requests)
      await b.waitForFunction(() => !!t.decide)
      await a.evaluate(async change => {
        if (change === 'clear') await t.vault.clear(t.persona)
        else {
          const result = await t.vault.enrol(t.ctx(), t.identity, Math.floor(Date.now() / 1000) + 86_400, { replace: true })
          if (!result.ok) throw new Error(result.refusal)
        }
      }, change)
      // No delayed storage-event callback is needed to reject an old reply.
      expect(await b.evaluate(request => t.vault.acceptSignReply(request, t.earlier.value), requests[0])).toEqual({ ok: false, refusal: 'stale' })
      const records = (page: Page) => page.evaluate(() => new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('kithmoot-mls-vault-v1')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const get = db.transaction('records').objectStore('records').getAll()
          get.onsuccess = () => { db.close(); resolve(JSON.stringify(get.result.map(r => [r.name, Array.from(new Uint8Array(r.ciphertext))]))) }
          get.onerror = () => reject(get.error)
        }
      }))
      const before = await records(a)
      expect(await b.evaluate(async decision => { t.decide(decision); return await t.pending }, decision)).toEqual({ ok: false, refusal: 'stale' })
      expect(await records(a)).toBe(before) // Neither policy nor denial journal is resurrected.
      expect(await b.evaluate(async () => t.vault.device(t.oldContext))).toEqual({ ok: false, refusal: 'stale' })
      const fresh = await b.evaluate(async () => t.vault.device(t.ctx()))
      expect(fresh.ok).toBe(change === 'replace')
      await context.close()
    })
  }
}

test('a corrupt record refuses rather than falling back', async ({ browser }) => {
  const context = await browser.newContext()
  await serve(context)
  const page = await open(context)
  const secret = await page.evaluate(() => V.bytesToHex(V.generateSecretKey()))
  await page.evaluate(`(${setup})('${secret}')`)
  const outcome = await page.evaluate(async () => {
    const now = Math.floor(Date.now() / 1000)
    const enrolled = await t.vault.enrol(t.ctx(), t.identity, now + 86_400)
    if (!enrolled.ok) throw new Error(enrolled.refusal)
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('kithmoot-mls-vault-v1')
      open.onsuccess = () => {
        const tx = open.result.transaction('records', 'readwrite')
        const store = tx.objectStore('records')
        const all = store.getAll()
        all.onsuccess = () => {
          for (const record of all.result) { new Uint8Array(record.ciphertext)[0] ^= 1; store.put(record) }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
    })
    const fresh = new V.MlsVault(new V.BrowserMlsVaultStorage())
    try { await fresh.device(fresh.context(location.origin, t.persona)); return 'opened' }
    catch (error) { return String(error) }
  })
  expect(outcome).toMatch(/could not be opened/)
  await context.close()
})

declare global {
  // eslint-disable-next-line no-var
  var V: any
  // eslint-disable-next-line no-var
  var t: any
}
