import { build } from 'esbuild'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { expect, test, type Page, type Route } from '@playwright/test'
import { preparedRestart } from './ordinary-prepared-extension.setup.js'

const ORIGIN = 'https://ordinary-renewal-startup.invalid'
const LOCK = 'kithmoot-ordinary-state-v1:migration'
let entry = ''
let navigationServer: Server, navigationOrigin = ''
const navigationHides: boolean[] = []
test.beforeAll(async () => {
  entry = (await build({ entryPoints: ['app/src/ordinary-startup-entry.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', plugins: [{ name: 'observe-deferred-legacy-modules', setup(builder) {
      builder.onResolve({ filter: /^\.\/(text-size|call-folds|main)\.js$/ }, input => {
        if (!input.importer.endsWith('/app/src/ordinary-startup-entry.ts')) return undefined
        return { path: '/normal/' + input.path.slice(2), external: true }
      })
    } }] })).outputFiles[0]!.text
  navigationServer = createServer((request, response) => {
    if (request.url?.startsWith('/record-hide?')) {
      const value = new URL(request.url, 'http://fixture.invalid').searchParams.get('persisted')
      if (value === '0' || value === '1') navigationHides.push(value === '1')
      response.writeHead(204); response.end(); return
    }
    response.setHeader('cache-control', 'max-age=3600')
    if (request.url === '/startup-entry.js') { response.setHeader('content-type', 'text/javascript'); response.end(entry); return }
    if (request.url?.startsWith('/normal/')) {
      response.setHeader('content-type', 'text/javascript')
      response.end(`window.normalImports.push(${JSON.stringify(request.url.split('/').pop())});${request.url.endsWith('/main.js') ? "window.addEventListener('pageshow', e => { if(e.persisted) window.name='late-legacy-pageshow' });" : ''}export {}`); return
    }
    response.setHeader('content-type', 'text/html')
    response.end(request.url === '/away' ? '<!doctype html><p>Away</p>' : `<!doctype html><html data-ordinary-startup="checking"><body><div id="ordinaryStartupNotice">Checking</div><script>window.normalImports=[];window.instanceMarker=Date.now()+Math.random();window.addEventListener('pagehide', e => { navigator.sendBeacon('/record-hide?persisted='+Number(e.persisted)); });</script><script type="module" src="/startup-entry.js"></script></body></html>`)
  })
  await new Promise<void>(resolve => navigationServer.listen(0, '127.0.0.1', resolve))
  const address = navigationServer.address(); if (!address || typeof address === 'string') throw new Error('navigation fixture missing')
  navigationOrigin = `http://127.0.0.1:${address.port}`
})
test.afterAll(() => new Promise<void>((resolve, reject) => navigationServer.close(error => error ? reject(error) : resolve())))
async function enter(page: Page, intercept?: (route: Route) => Promise<boolean>): Promise<void> {
  await page.context().route(ORIGIN + '/startup-entry.js', route => route.fulfill({ contentType: 'text/javascript', body: entry }))
  await page.context().route(ORIGIN + '/normal/**', async route => {
    if (await intercept?.(route)) return
    await route.fulfill({ contentType: 'text/javascript', body: `window.normalImports.push(${JSON.stringify(route.request().url().split('/').pop())});export {}` })
  })
  await page.evaluate(() => {
    const w = window as any
    document.documentElement.dataset.ordinaryStartup = 'checking'
    document.body.innerHTML = '<div id="ordinaryStartupNotice">Checking saved room state…</div>'
    w.rootEntropyStacks = []
    const random = crypto.getRandomValues.bind(crypto)
    crypto.getRandomValues = (...args) => { w.rootEntropyStacks.push(new Error('startup entropy').stack); return random(...args) }
    w.normalImports = []; w.storageReads = 0; w.storageWrites = 0; w.providerReads = 0
    const get = Storage.prototype.getItem
    Storage.prototype.getItem = function (key) { w.storageReads++; return get.call(this, key) }
    for (const method of ['setItem', 'removeItem', 'clear'] as const) {
      const original = Storage.prototype[method]
      ;(Storage.prototype as any)[method] = function (...args: unknown[]) { w.storageWrites++; return (original as any).apply(this, args) }
    }
    Object.defineProperty(window, 'nostr', { configurable: true, get() { w.providerReads++; throw new Error('startup provider access') } })
  })
  await page.evaluate(url => import(/* @vite-ignore */ url), ORIGIN + '/startup-entry.js')
  await page.waitForFunction("document.documentElement.dataset.ordinaryStartup !== 'checking'")
}
async function exclusive(page: Page): Promise<boolean> {
  return page.evaluate(lock => navigator.locks.request(lock, { mode: 'exclusive', ifAvailable: true }, held => !!held), LOCK)
}

test('HTML has one ordered application entry before private modules', async () => {
  const html = await readFile('app/index.html', 'utf8')
  expect([...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => match[1])).toEqual(['/src/ordinary-startup-entry.ts'])
  expect(html).toContain('data-ordinary-startup="checking"')
})
test('empty first load imports in order without creating custody or requiring a worker', async ({ page }) => {
  await enter(page)
  expect(await page.evaluate('[normalImports, storageReads, storageWrites, providerReads]')).toEqual([
    ['text-size.js', 'call-folds.js', 'main.js'], 0, 0, 0,
  ])
  expect(await page.evaluate('rootEntropyStacks')).toEqual([])
  expect(await page.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true)
  expect(await page.evaluate('indexedDB.databases().then(rows => rows.some(row => row.name === Ordinary.ORDINARY_DATABASE))')).toBe(false)
  const other = await page.context().newPage(); await other.goto(ORIGIN)
  expect(await exclusive(other)).toBe(false)
  await page.close()
  await expect.poll(() => exclusive(other)).toBe(true)
})
for (const phase of ['ordinary', 'prepared', 'provider-started', 'provider-returned', 'candidate-prepared', 'candidate-committed', 'settled'] as const) {
  test(`protected ${phase} holds intact before legacy storage or provider access`, async ({ page }) => {
    await preparedRestart(page, false, true, false, undefined, phase)
    const before = await page.evaluate('readPreparedRows().then(rows => rows.map(([name, row]) => [name, name.startsWith(Ordinary.ORDINARY_OPERATION_CONTROL_PREFIX) ? Ordinary.ordinaryOperationControlDigest(row) : Ordinary.ordinaryFrameDigest(row.frame)]))')
    const cuts = await page.evaluate('[entropy, puts, signCalls]')
    await enter(page)
    expect(await page.evaluate('[document.documentElement.dataset.ordinaryStartup, normalImports, storageReads, storageWrites, providerReads]')).toEqual(['held', [], 0, 0, 0])
    expect(await page.evaluate('[entropy, puts, signCalls]'), JSON.stringify(await page.evaluate('rootEntropyStacks'))).toEqual(cuts)
    expect(await page.evaluate('readPreparedRows().then(rows => rows.map(([name, row]) => [name, name.startsWith(Ordinary.ORDINARY_OPERATION_CONTROL_PREFIX) ? Ordinary.ordinaryOperationControlDigest(row) : Ordinary.ordinaryFrameDigest(row.frame)]))')).toEqual(before)
    await expect.poll(() => exclusive(page)).toBe(true)
  })
}

test('an exclusive migration completes before startup can classify empty', async ({ page }) => {
  const other = await page.context().newPage(); await other.goto(ORIGIN)
  await other.evaluate(lock => {
    const w = window as any
    w.migration = navigator.locks.request(lock, { mode: 'exclusive' }, async () => {
      w.migrating = true
      await new Promise<void>(resolve => { w.releaseMigration = resolve })
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('kithmoot-ordinary-state-v1', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('owners')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => { request.result.close(); resolve() }
      })
    })
  }, LOCK)
  await other.waitForFunction('window.migrating')
  // enter waits on the real exclusive migration. A separate page releases it
  // only after writing a nonempty-database disposition, which must then hold.
  const entering = enter(page)
  await page.waitForFunction('window.normalImports !== undefined')
  expect(await page.evaluate('normalImports')).toEqual([])
  await other.evaluate('releaseMigration(); migration')
  await entering
  expect(await page.evaluate('[document.documentElement.dataset.ordinaryStartup, normalImports]')).toEqual(['held', []])
})

test('all live legacy pages retain both migration and native write leases', async ({ page }) => {
  const context = page.context(), b = await context.newPage(), writer = await context.newPage()
  await b.goto(ORIGIN); await writer.goto(ORIGIN)
  await enter(page); await enter(b)
  for (const name of [LOCK, 'kithmoot-ordinary-state-v1:write']) {
    expect(await writer.evaluate(lock => navigator.locks.request(lock, { mode: 'exclusive', ifAvailable: true }, held => !!held), name)).toBe(false)
  }
  await page.close()
  expect(await exclusive(writer)).toBe(false)
  await b.close()
  await expect.poll(() => exclusive(writer)).toBe(true)
})

test('an actual ordinary owner writer cannot allocate while a legacy document lives', async ({ page }) => {
  await enter(page)
  const writer = await page.context().newPage(); await writer.goto(ORIGIN)
  await writer.evaluate(() => {
    const w = window as any, random = crypto.getRandomValues.bind(crypto)
    w.writerEntropy = 0
    crypto.getRandomValues = (...args) => { w.writerEntropy++; return random(...args) }
    w.owner = new w.Ordinary.OrdinaryStateOwner()
    w.writeStatus = 'pending'
    w.writing = w.owner.prepare(() => true, new Map()).then(() => { w.writeStatus = 'done' }, (e: Error) => { w.writeStatus = e.name })
  })
  await expect.poll(() => writer.evaluate(() => navigator.locks.query().then(state => state.pending?.some(lock => lock.name === 'kithmoot-ordinary-state-v1:write')))).toBe(true)
  expect(await writer.evaluate('[writeStatus, writerEntropy]')).toEqual(['pending', 0])
  expect(await writer.evaluate('indexedDB.databases().then(rows => rows.some(row => row.name === Ordinary.ORDINARY_DATABASE))')).toBe(false)
  await page.close()
  await writer.evaluate('writing')
  expect(await writer.evaluate('writeStatus')).toBe('done')
  expect(await writer.evaluate('writerEntropy')).toBeGreaterThan(0)
  await writer.evaluate('owner.close()')
})

for (const name of ['text-size.js', 'call-folds.js', 'main.js']) {
  for (const cut of ['pagehide', 'persisted-pagehide', 'throw']) {
    test(`${cut} during ${name} cannot release either lease or start a later import`, async ({ page }) => {
      const other = await page.context().newPage(); await other.goto(ORIGIN)
      let arrived!: () => void, release!: () => void
      const arriving = new Promise<void>(resolve => { arrived = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const entering = enter(page, async route => {
        if (!route.request().url().endsWith('/' + name)) return false
        arrived(); await gate
        await route.fulfill({ contentType: 'text/javascript', body: `window.normalImports.push(${JSON.stringify(name)});${cut === 'throw' ? 'throw new Error("partial legacy evaluation");' : 'export {}'}` })
        return true
      })
      await arriving
      if (cut !== 'throw') await page.evaluate(persisted => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted })), cut === 'persisted-pagehide')
      for (const lock of [LOCK, 'kithmoot-ordinary-state-v1:write']) {
        expect(await other.evaluate(name => navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, held => !!held), lock)).toBe(false)
      }
      release(); await entering
      const names = ['text-size.js', 'call-folds.js', 'main.js']
      expect(await page.evaluate('[document.documentElement.dataset.ordinaryStartup, normalImports]')).toEqual(['held', names.slice(0, names.indexOf(name) + 1)])
      expect(await exclusive(other)).toBe(false)
      await page.close()
      await expect.poll(() => exclusive(other)).toBe(true)
    })
  }
}

test('every existing database schema holds without a protected-state import', async ({ page }) => {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('kithmoot-ordinary-state-v1', 7)
      request.onupgradeneeded = () => request.result.createObjectStore('unexpected-private-schema')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => { request.result.close(); resolve() }
    })
  })
  await enter(page)
  expect(await page.evaluate('[document.documentElement.dataset.ordinaryStartup, normalImports, rootEntropyStacks, storageReads, storageWrites, providerReads]')).toEqual(['held', [], [], 0, 0, 0])
  await expect.poll(() => exclusive(page)).toBe(true)
})

test('pagehide joins a queued native open before releasing either lease', async ({ page }) => {
  await page.evaluate(async () => {
    const w = window as any
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('kithmoot-ordinary-state-v1', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('owners')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => { w.blockingDatabase = request.result; resolve() }
    })
    const deletion = indexedDB.deleteDatabase('kithmoot-ordinary-state-v1')
    deletion.onblocked = () => { w.deletionBlocked = true }
    const open = indexedDB.open.bind(indexedDB)
    indexedDB.open = (...args: Parameters<IDBFactory['open']>) => { w.rootOpenStarted = true; return open(...args) }
  })
  await page.waitForFunction('window.deletionBlocked')
  const other = await page.context().newPage(); await other.goto(ORIGIN)
  const entering = enter(page)
  await page.waitForFunction('window.rootOpenStarted')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await exclusive(other)).toBe(false)
  expect(await page.evaluate('normalImports')).toEqual([])
  await page.evaluate('blockingDatabase.close()')
  await entering
  expect(await page.evaluate('[document.documentElement.dataset.ordinaryStartup, normalImports]')).toEqual(['held', []])
  await expect.poll(() => exclusive(other)).toBe(true)
})

test('real navigation and back cannot resume the previous legacy graph', async ({ browser }) => {
  // Explicitly remove Playwright's Chromium BFCache-disable default. The
  // other engines receive the same request without a synthetic page event.
  const native = await browser.browserType().launch({ ignoreDefaultArgs: ['--disable-back-forward-cache'] })
  const context = await native.newContext(), page = await context.newPage(), other = await context.newPage()
  navigationHides.length = 0
  try {
    await page.goto(navigationOrigin)
    await page.waitForFunction("document.documentElement.dataset.ordinaryStartup === 'ready'")
    const original = await page.evaluate('instanceMarker')
    await other.goto(navigationOrigin + '/away')
    await page.goto(navigationOrigin + '/away')
    const migrated = await other.evaluate(async () => navigator.locks.request('kithmoot-ordinary-state-v1:migration', { mode: 'exclusive', ifAvailable: true }, async migration => {
      if (!migration) return false
      return navigator.locks.request('kithmoot-ordinary-state-v1:write', { mode: 'exclusive', ifAvailable: true }, async write => {
        if (!write) return false
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('kithmoot-ordinary-state-v1', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('owners')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => { request.result.close(); resolve() }
        })
        return true
      })
    }))
    await page.goBack()
    await page.waitForFunction("document.documentElement.dataset.ordinaryStartup === 'ready' || document.documentElement.dataset.ordinaryStartup === 'held'")
    // Both the lock-blocked BFCache path and the capture/reload defence
    // require a new document before any legacy handler can resume.
    await expect.poll(() => page.evaluate('instanceMarker')).not.toBe(original)
    expect(await page.evaluate('window.name')).not.toBe('late-legacy-pageshow')
    expect(await page.evaluate('document.documentElement.dataset.ordinaryStartup')).toBe(migrated ? 'held' : 'ready')
    if (migrated) expect(await page.evaluate('normalImports')).toEqual([])
    await expect.poll(() => navigationHides.length).toBeGreaterThan(0)
    console.log('native BFCache observation', JSON.stringify({ engine: browser.browserType().name(), pagehidePersisted: navigationHides, migrated, freshDocument: true }))
  } finally { await context.close(); await native.close() }
})

test('synthetic persisted pageshow cannot run a later legacy handler before reload', async ({ page }) => {
  await page.goto(navigationOrigin)
  await page.waitForFunction("document.documentElement.dataset.ordinaryStartup === 'ready'")
  const original = await page.evaluate('instanceMarker')
  await page.evaluate(() => window.addEventListener('pageshow', () => { window.name = 'late-synthetic-handler' }, { capture: true }))
  const reloaded = page.waitForEvent('framenavigated', frame => frame === page.mainFrame())
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  await reloaded
  await page.waitForFunction("document.documentElement.dataset.ordinaryStartup === 'ready'")
  expect(await page.evaluate('instanceMarker')).not.toBe(original)
  expect(await page.evaluate('window.name')).not.toBe('late-synthetic-handler')
})
