import { build } from 'esbuild'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-member-session.setup.js'

let server: Server, origin = '', fixture = '', worker = '', pureFence = ''
const modules = new Map<string, string>()
const ROOT_ENTRY = '/j/build/ordinary-private-existing-root.browser-entry.js'
const probes = `window.effects={provider:0,socket:0,storageWrite:0,put:0,entropy:0,key:0};window.probeNonces=0;window.curveInitializationProbes=0;window.curveProbeActive=false;window.privateEntropyCalls=[];
const nativeProbeRandom=crypto.getRandomValues.bind(crypto);window.__probeRandom=value=>{probeNonces++;return nativeProbeRandom(value)};
window.__curveProbeRandom=(random,length)=>{curveInitializationProbes++;curveProbeActive=true;try{return random(length)}finally{curveProbeActive=false}};
Object.defineProperty(window,'nostr',{get(){effects.provider++;if(window.providerFixture)return window.providerFixture.current;throw Error('provider forbidden')}});
window.WebSocket=class{constructor(){effects.socket++;throw Error('socket forbidden')}};
for(const name of ['setItem','removeItem','clear'])Storage.prototype[name]=()=>{effects.storageWrite++;throw Error('Storage write forbidden')};
for(const name of ['put','add','delete','clear'])IDBObjectStore.prototype[name]=()=>{effects.put++;throw Error('native write forbidden')};
crypto.getRandomValues=value=>{if(curveProbeActive)return nativeProbeRandom(value);effects.entropy++;const error=Error('entropy forbidden');privateEntropyCalls.push(error.stack);throw error};
crypto.subtle.generateKey=()=>{effects.key++;throw Error('key allocation forbidden')};`
const none = { provider: 0, socket: 0, storageWrite: 0, put: 0, entropy: 0, key: 0 }

test.beforeAll(async () => {
  const result = await build({ entryPoints: ['test/ordinary-private-existing-root.browser-entry.ts'],
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    outdir: '.private-root-test-build', chunkNames: 'chunks/[name]-[hash]', write: false, metafile: true,
    plugins: [{ name: 'observe-private-root-failure-only', setup(builder) {
      builder.onLoad({ filter: /ordinary-private-existing-root\.ts$/ }, async input => {
        const source = await readFile(input.path, 'utf8'), marker = '}, async () => {\n      this.#stop()'
        if (source.split(marker).length !== 2) throw Error('Private root observation fixture drift')
        return { loader: 'ts', contents: source.replace(marker,
          '}, async (error) => { (globalThis as any).__rootFailure=error?.stack; this.#stop()').replace(
            '}, async () => { this.#stop(); await this.close() })',
            '}, async (error) => { (globalThis as any).__providerFailure=error?.stack; this.#stop(); await this.close() })').replace(
            'this.#provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot)',
            `const provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot)
             if ((globalThis as any).providerFixture?.cutAssignment === 'before') window.dispatchEvent(new PageTransitionEvent('pagehide'))
             this.#provider = provider
             if ((globalThis as any).providerFixture?.cutAssignment === 'after') window.dispatchEvent(new PageTransitionEvent('pagehide'))`).replace(
            '#pagehide = () => { void this.close().catch(() => {}) }',
            '#pagehide = () => { void this.close().catch(error => { (globalThis as any).__rootCloseFailure=error?.message }) }') }
      })
      builder.onLoad({ filter: /ordinary-state-owner\.ts$/ }, async input => {
        const source = await readFile(input.path, 'utf8'), marker = 'raw = await sdk; check()'
        if (source.split(marker).length !== 2) throw Error('Private provider SDK close fixture drift')
        // Wrap only this checkpoint's already-created actual SDK signer. Its
        // real close still runs; explicit fault fixtures delay/reject its join.
        return { loader: 'ts', contents: source.replace(marker, `raw = await sdk;
          const fixture = (globalThis as any).providerFixture
          if (fixture?.closeMode) {
            const actual = raw
            raw = new Proxy(actual, { get(target, key) {
              if (key !== 'close') return Reflect.get(target, key, target)
              return async () => {
                fixture.closeCalls = (fixture.closeCalls ?? 0) + 1
                await actual.close()
                if (fixture.closeMode === 'pending') await new Promise<void>(yes => { fixture.closeRelease = yes })
                fixture.closeTerminal = true
                if (fixture.closeMode === 'reject') throw Error('Explicit SDK close fixture rejection')
              }
            } })
          }
          check()`) }
      })
      builder.onLoad({ filter: /ordinary-state-clients\.ts$/ }, async input => {
        const source = await readFile(input.path, 'utf8'), marker = 'crypto.getRandomValues(new Uint8Array(32))'
        if (source.split(marker).length !== 2) throw Error('Public probe nonce fixture drift')
        // Count the exact public fence nonce call separately while keeping its
        // real native entropy. All private ID/key entropy remains forbidden.
        return { loader: 'ts', contents: source.replace(marker, '(globalThis as any).__probeRandom(new Uint8Array(32))') }
      })
      builder.onLoad({ filter: /@noble[/\\]curves[/\\]abstract[/\\]curve\.js$/ }, async input => {
        const source = await readFile(input.path, 'utf8'), marker = 'const probe = randomBytes(length);'
        // Other installed Noble versions lack this optional capability probe.
        // Observe only its exact implementation, regardless of npm hoisting.
        if (!source.includes('function probeRandomBytes(')) return undefined
        if (source.split(marker).length !== 2) throw Error('Noble initialization probe fixture drift')
        // Preserve the cryptographic library's actual RNG-capability probe.
        // This call allocates no tab marker, identity, native key or owner row.
        return { loader: 'js', contents: source.replace(marker, 'const probe = globalThis.__curveProbeRandom(randomBytes, length);') }
      })
    } }] })
  for (const file of result.outputFiles) modules.set('/j/build/' + relative(resolve('.private-root-test-build'), file.path), file.text)
  // Follow static imports only: owner/SDK code must stay behind the actual
  // presence decision and worker fence, including after bundler splitting.
  const meta = result.metafile!, entry = Object.keys(meta.outputs).find(name => meta.outputs[name]!.entryPoint === 'test/ordinary-private-existing-root.browser-entry.ts')!
  const staticInputs = new Set<string>(), visited = new Set<string>()
  const visit = (name: string) => {
    if (visited.has(name)) return
    visited.add(name)
    for (const input of Object.keys(meta.outputs[name]!.inputs)) staticInputs.add(input)
    for (const dependency of meta.outputs[name]!.imports) if (dependency.kind !== 'dynamic-import' && !dependency.external) visit(dependency.path)
  }
  visit(entry)
  expect([...staticInputs].some(name => /ordinary-state-owner|signet-login|nostr-tools|ordinary-foreground-signer/.test(name))).toBe(false)
  modules.set('/j/mutate-native.js', (await build({
    entryPoints: ['test/ordinary-private-provider-mutation.browser-entry.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', write: false,
  })).outputFiles[0]!.text)
  fixture = (await build({ entryPoints: ['test/ordinary-bootstrap.browser-entry.ts'], bundle: true,
    format: 'iife', globalName: 'Ordinary', platform: 'browser', target: 'es2022', write: false })).outputFiles[0]!.text
  pureFence = (await build({ entryPoints: ['test/ordinary-protected-worker.browser-entry.ts'], bundle: true,
    format: 'iife', globalName: 'FenceOnly', platform: 'browser', target: 'es2022', write: false })).outputFiles[0]!.text
  worker = await readFile('app/public/ordinary-state-sw.js', 'utf8')
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid')
    res.setHeader('cache-control', 'no-store')
    if (url.pathname === '/j/sw.js') {
      res.setHeader('content-type', 'text/javascript')
      res.end("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));" +
        (url.search ? "self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));" : '') + worker)
    } else if (modules.has(url.pathname)) {
      res.setHeader('content-type', 'text/javascript'); res.end(modules.get(url.pathname))
    } else {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.pathname === '/outside/legacy') res.end('<!doctype html><title>Unresponsive other window</title>')
      else if (url.pathname === '/outside/modern') res.end(`<!doctype html><script>${pureFence.replace(/<\/script/gi, '<\\/script')}</script>`)
      else if (url.pathname === '/j/setup') res.end(`<!doctype html><script>${fixture.replace(/<\/script/gi, '<\\/script')}</script>`)
      else res.end(`<!doctype html><script>${probes}</script><script type="module" src="${ROOT_ENTRY}"></script>`)
    }
  })
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing native root server')
  origin = `http://127.0.0.1:${address.port}`
})
test.afterAll(() => new Promise<void>((yes, no) => server?.close(error => error ? no(error) : yes())))
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => console.error('Private root fixture page error:', error.message))
  page.on('console', message => { if (message.type() === 'error') console.error('Private root fixture console:', message.text()) })
})

async function seed(page: Page, keep = true, visitor = false): Promise<string> {
  await page.goto(origin + '/j/setup')
  await page.evaluate(`(${setup})(${JSON.stringify({ keep, visitor, noRelays: true })})`)
  return page.evaluate(async () => {
    const w = window as any, o = w.Ordinary
    const result = await w.bootstrap.bootstrap(w.evidence)
    o.wipeOrdinaryPersistentBootstrapResult(result)
    sessionStorage.setItem('kithmoot.ordinary-tab.v1', w.tabPurpose.slice(4))
    return w.url
  })
}
async function install(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/j/sw.js', { scope: '/j/', updateViaCache: 'none' })
    if (!registration.active) await new Promise<void>((yes, no) => {
      const worker = registration.installing ?? registration.waiting
      if (!worker) { no(Error('Missing native worker')); return }
      const changed = () => {
        if (worker.state === 'activated') { worker.removeEventListener('statechange', changed); yes() }
        else if (worker.state === 'redundant') { worker.removeEventListener('statechange', changed); no(Error('Worker failed')) }
      }
      worker.addEventListener('statechange', changed); changed()
    })
  })
}
async function releaseFixture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as any
    await w.bootstrap.close(); await w.browserOwner.close(); await w.tabOwner.close()
  })
}
async function enter(page: Page, href: string, expected: 'held' | 'captured-held'): Promise<void> {
  await releaseFixture(page)
  await page.goto(href)
  await page.waitForFunction(() => ['held', 'captured-held'].includes(document.documentElement.dataset.ordinaryProtectedStartup ?? ''))
  const state = await page.evaluate('({state:document.documentElement.dataset.ordinaryProtectedStartup,error:window.__rootFailure,effects,privateEntropyCalls})')
  expect(state, JSON.stringify(state)).toMatchObject({ state: expected, effects: none })
  expect(await page.evaluate('effects')).toEqual(none)
}
async function lockAvailable(page: Page, suffix: string): Promise<boolean> {
  return page.evaluate(suffix => navigator.locks.request('kithmoot-ordinary-state-v1:' + suffix,
    { ifAvailable: true }, lock => !!lock), suffix)
}

for (const keep of [false, true]) {
  test(`fixed private capture authenticates existing NIP07 custody without effects, keep=${keep}`, async ({ page }) => {
    const href = await seed(page, keep)
    await install(page)
    const before = await page.evaluate('rawBoth().then(rows=>rows.map(row=>JSON.stringify(row.frame)))')
    await enter(page, href, 'captured-held')
    expect(await page.evaluate('probeNonces')).toBe(3)
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    expect(await lockAvailable(page, 'write')).toBe(true)
    // A completed capture still owns its tab and MIGRATION until actual close.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
    expect(await page.evaluate('effects')).toEqual(none)
    const after = await page.evaluate(() => new Promise<string[]>((yes, no) => {
      const request = indexedDB.open('kithmoot-ordinary-state-v1')
      request.onerror = () => no(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('owners'), store = tx.objectStore('owners')
        const browser = store.get('browser'), tab = store.get('tab:' + 'a'.repeat(64))
        tx.oncomplete = () => { db.close(); yes([browser.result, tab.result].map(row => JSON.stringify(row.frame))) }
        tx.onabort = () => { db.close(); no(tx.error) }
      }
    }))
    expect(after).toEqual(before)
  })
}

for (const keep of [false, true]) {
  test(`capture accepts a current native lease after its bootstrap credential expires, keep=${keep}`, async ({ page }) => {
    await page.clock.install()
    await page.goto(origin + '/j/setup')
    await page.evaluate(`(${setup})(${JSON.stringify({ keep, noRelays: true })})`)
    // Match the existing member-restoration fixture's synthetic epoch budget.
    // This test asserts authenticated renewal/capture, not a one-second relay deadline.
    await page.evaluate('window.memberEpochTimeoutMs=10000')
    await page.evaluate(`(${controls})()`)
    await page.evaluate('member.join()')
    await page.clock.fastForward(901_000)
    await expect.poll(() => page.evaluate(`(async()=>{try{const result=await bootstrap.load();
      try{return result.sealKeys.length}finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(result)}}catch{return 0}})()`)).toBe(2)
    const href = await page.evaluate(async () => {
      const w = window as any, result = await w.bootstrap.load()
      try {
        if (Number(result.credential.tags[2][1]) <= w.credentialExpiresAt) throw Error('Native lease did not renew')
        w.currentCredentialExpiry = Number(result.credential.tags[2][1])
      } finally { w.Ordinary.wipeOrdinaryPersistentBootstrapResult(result) }
      // Stop renewal before moving past the historical bootstrap expiry.
      await w.member.close(); await w.bootstrap.close()
      sessionStorage.setItem('kithmoot.ordinary-tab.v1', w.tabPurpose.slice(4))
      return w.url
    })
    await page.clock.fastForward(900_001)
    expect(await page.evaluate('Math.floor(Date.now()/1000)>credentialExpiresAt&&currentCredentialExpiry-Math.floor(Date.now()/1000)>=600')).toBe(true)
    await install(page)
    await enter(page, href, 'captured-held')
    expect(await lockAvailable(page, 'migration')).toBe(false)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await page.evaluate('effects')).toEqual(none)
  })
}

for (const fault of ['missing-marker', 'invalid-marker', 'missing-tab', 'missing-browser', 'wrong-url',
  'account', 'method', 'pending-login', 'expired-tab', 'expired-credential', 'metadata'] as const) {
  test(`actual private root holds ${fault} without native or provider effects`, async ({ page }) => {
    let href = await seed(page)
    await install(page)
    if (fault === 'missing-marker') await page.evaluate(() => sessionStorage.removeItem('kithmoot.ordinary-tab.v1'))
    else if (fault === 'invalid-marker') await page.evaluate(() => sessionStorage.setItem('kithmoot.ordinary-tab.v1', 'invalid'))
    else if (fault === 'wrong-url') href = origin + '/j/#wrong'
    else if (fault === 'expired-tab' || fault === 'expired-credential') {
      await page.clock.install()
      await page.clock.fastForward(fault === 'expired-tab' ? 3_600_001 : 1_800_001)
    } else if (fault === 'missing-tab' || fault === 'missing-browser') await page.evaluate(async fault => {
      const request = indexedDB.open('kithmoot-ordinary-state-v1')
      const db = await new Promise<IDBDatabase>((yes, no) => { request.onsuccess = () => yes(request.result); request.onerror = () => no(request.error) })
      const tx = db.transaction('owners', 'readwrite')
      tx.objectStore('owners').delete(fault === 'missing-tab' ? 'tab:' + 'a'.repeat(64) : 'browser')
      await new Promise<void>((yes, no) => { tx.oncomplete = () => yes(); tx.onabort = () => no(tx.error) }); db.close()
    }, fault)
    else await page.evaluate(async fault => {
      const w = window as any
      await w.pair((browser: any) => {
        const k = w.Ordinary.ORDINARY_SIGNET_KEYS
        if (fault === 'account') browser.set(k.pubkey, 'f'.repeat(64))
        else if (fault === 'method') browser.set(k.method, 'bunker')
        else if (fault === 'pending-login') browser.set(k.pendingRedirect, '{}')
        else {
          const name = w.prefix + 'kithmoot.room.' + w.roomId, value = JSON.parse(browser.get(name))
          browser.set(name, JSON.stringify({ ...value, link: location.origin + '/j/#wrong' }))
        }
      })
    }, fault)
    await enter(page, href, 'held')
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  })
}

test('first uncontrolled document cannot substitute later worker activation for entry control', async ({ page }) => {
  const href = await seed(page)
  await enter(page, href, 'held')
  expect(await lockAvailable(page, 'migration')).toBe(true)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.ordinaryProtectedStartup === 'captured-held')
  expect(await page.evaluate('effects')).toEqual(none)
})

test('a visitor proof cannot select the account-bound NIP07 checkpoint', async ({ page }) => {
  const href = await seed(page, false, true)
  await install(page)
  await enter(page, href, 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

test('actual worker-controller replacement closes the captured root and releases MIGRATION last', async ({ page }) => {
  const href = await seed(page)
  await install(page)
  await enter(page, href, 'captured-held')
  await page.evaluate(() => navigator.serviceWorker.register('/j/sw.js?replacement', { scope: '/j/', updateViaCache: 'none' }))
  await page.waitForFunction(() => document.documentElement.dataset.ordinaryProtectedStartup === 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('effects')).toEqual(none)
})

test('repeated entry cannot replay capture or revive a closed document root', async ({ page }) => {
  const href = await seed(page)
  await install(page)
  await enter(page, href, 'captured-held')
  const capturedProbes = await page.evaluate<[number, number]>('[probeNonces,curveInitializationProbes]')
  expect(capturedProbes[0]).toBe(3)
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.prepareOrdinaryPrivateExistingRoot())`)
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual(capturedProbes)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.prepareOrdinaryPrivateExistingRoot())`)
  expect(await page.evaluate('document.documentElement.dataset.ordinaryProtectedStartup')).toBe('held')
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual(capturedProbes)
  expect(await page.evaluate('effects')).toEqual(none)
})

test('the lexical native bridge refuses forged and proxy roots without invoking getters', async ({ page }) => {
  await page.goto(origin + '/j/setup')
  expect(await page.evaluate(() => {
    const w = window as any
    let getters = 0, refused = 0
    for (const name of ['beginOrdinaryPrivateExistingCapture', 'beginOrdinaryPrivateExistingProvider']) {
      if (typeof w.Ordinary[name] !== 'function') throw Error('Missing fixed native bridge: ' + name)
      for (const root of [{}, Object.freeze({}), new Proxy({}, { get() { getters++; throw Error('caller getter') } })]) {
        try { w.Ordinary[name](root) } catch { refused++ }
      }
    }
    return { getters, refused }
  })).toEqual({ getters: 0, refused: 6 })
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([])
})

test('a retained marker cannot create an absent database or a replacement tab identity', async ({ page }) => {
  await page.goto(origin + '/j/setup')
  await page.evaluate(() => sessionStorage.setItem('kithmoot.ordinary-tab.v1', 'a'.repeat(64)))
  await install(page)
  await page.goto(origin + '/j/')
  await page.waitForFunction(() => document.documentElement.dataset.ordinaryProtectedStartup === 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([])
  expect(await page.evaluate('effects')).toEqual(none)
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual([0, 0])
})

test('an unresponsive outside-scope window holds before owner/SDK import', async ({ page, context }) => {
  const href = await seed(page)
  await install(page)
  const other = await context.newPage()
  await other.goto(origin + '/outside/legacy')
  await enter(page, href, 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual([1, 0])
  await other.close()
})

test('an acknowledged outside-scope window owning the exact tab marker prevents restoration', async ({ page, context }) => {
  const href = await seed(page)
  await install(page)
  const other = await context.newPage()
  await other.goto(origin + '/outside/modern')
  await other.evaluate(() => new Promise<void>(yes => {
    const w = window as any
    w.modernFence = new w.FenceOnly.OrdinaryClientFence()
    w.tabLockWork = navigator.locks.request('kithmoot-ordinary-state-v1:lifetime:' + 'a'.repeat(64), async () => {
      await new Promise<void>(release => { w.releaseTabLock = release; yes() })
    })
  }))
  await enter(page, href, 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual([1, 0])
  await other.evaluate(async () => { const w = window as any; w.releaseTabLock(); await w.tabLockWork; w.modernFence.close() })
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  await other.close()
})

for (const [target, outcome] of [['presence', 'success'], ['capture', 'success'], ['capture', 'version-error']] as const) {
  test(`pagehide joins delayed native ${target} ${outcome} terminal delivery before releasing MIGRATION`, async ({ page }) => {
    const href = await seed(page)
    await install(page)
    if (outcome === 'version-error') {
      await releaseFixture(page)
      await page.evaluate(() => new Promise<void>((yes, no) => {
        const request = indexedDB.open('kithmoot-ordinary-state-v1', 2)
        request.onsuccess = () => { request.result.close(); yes() }
        request.onerror = () => no(request.error)
        request.onblocked = () => no(Error('Fixture owner was not closed before upgrade'))
      }))
    }
    await page.addInitScript(target => {
      const w = window as any, native = indexedDB.open.bind(indexedDB), close = IDBDatabase.prototype.close
      let opened = 0
      w.nativeTail = { ready: false, closed: 0, delivered: false, kind: null, error: null }
      IDBDatabase.prototype.close = function () { w.nativeTail.closed++; return close.call(this) }
      indexedDB.open = ((...args: Parameters<IDBFactory['open']>) => {
        const request = native(...args)
        if (++opened !== (target === 'presence' ? 1 : 2)) return request
        const proxy = new Proxy(request, {
          get(object, name) { const value = Reflect.get(object, name, object); return typeof value === 'function' ? value.bind(object) : value },
          set(object, name, value) {
            if (name === 'onsuccess' || name === 'onerror') {
              Reflect.set(object, name, (event: Event) => {
                event.preventDefault(); w.nativeTail.ready = true
                w.nativeTail.kind = event.type; w.nativeTail.error = object.error?.name ?? null
                w.deliverNativeTail = () => { w.nativeTail.delivered = true; value.call(object, event) }
              }, object)
              return true
            }
            return Reflect.set(object, name, value, object)
          },
        })
        // Honest injection: the later success/error and database are native;
        // a version-one read did not naturally request an upgrade block.
        if (target === 'capture') queueMicrotask(() => request.dispatchEvent(new Event('blocked')))
        return proxy
      }) as IDBFactory['open']
    }, target)
    await releaseFixture(page)
    await page.goto(href)
    await page.waitForFunction('nativeTail.ready')
    expect(await page.evaluate('[nativeTail.kind,nativeTail.error]')).toEqual(outcome === 'success' ? ['success', null] : ['error', 'VersionError'])
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    expect(await page.evaluate('document.documentElement.dataset.ordinaryProtectedStartup')).toBe('held')
    expect(await lockAvailable(page, 'migration')).toBe(false)
    if (target === 'capture') expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    const before = await page.evaluate<number>('nativeTail.closed')
    await page.evaluate('deliverNativeTail()')
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    if (outcome === 'success') expect(await page.evaluate('nativeTail.closed')).toBeGreaterThan(before)
    expect(await page.evaluate('effects')).toEqual(none)
  })
}

async function providerFixture(page: Page, account: string, gated = false): Promise<void> {
  await page.addInitScript(({ account, gated }) => {
    const w = window as any
    const fixture: any = { account, gated, started: false, calls: 0, signs: 0, mutations: 0, release: undefined,
      nativeRandom: crypto.getRandomValues.bind(crypto), nativePut: IDBObjectStore.prototype.put }
    const provider = {
      getPublicKey: async () => {
        fixture.calls++; fixture.started = true
        if (fixture.gated) await new Promise<void>(yes => { fixture.release = yes })
        return fixture.account
      },
      signEvent: async () => { fixture.signs++; throw Error('Signing is outside provider discovery') },
    }
    fixture.current = provider; fixture.provider = provider; w.providerFixture = fixture
  }, { account, gated })
}
async function startProvider(page: Page): Promise<void> {
  await page.evaluate(`window.providerDone=false;window.providerOpening=import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot()).then(()=>{window.providerDone=true});undefined`)
}
async function providerState(page: Page, state: 'held' | 'provider-held'): Promise<void> {
  await page.waitForFunction(state => document.documentElement.dataset.ordinaryProtectedStartup === state, state)
  const result = await page.evaluate('({state:document.documentElement.dataset.ordinaryProtectedStartup,error:window.__providerFailure,effects})')
  expect(result, JSON.stringify(result)).toMatchObject({ state, effects: { ...none, provider: expect.any(Number) } })
}
for (const keep of [false, true]) test(`private root restores only its actual NIP07 provider account, keep=${keep}`, async ({ page }) => {
  const href = await seed(page, keep), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held')
  await startProvider(page); await providerState(page, 'provider-held')
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
  expect(await lockAvailable(page, 'write')).toBe(true)
  const nonces = await page.evaluate('probeNonces')
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot())`)
  expect(await page.evaluate('[providerFixture.calls,probeNonces]')).toEqual([1, nonces])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
})
for (const fault of ['account', 'missing-provider'] as const) test(`provider restoration refuses ${fault} without signing or writes`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, fault === 'account' ? 'f'.repeat(64) : account)
  await enter(page, href, 'captured-held')
  if (fault === 'missing-provider') await page.evaluate('providerFixture.current=undefined')
  await startProvider(page); await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([fault === 'account' ? 1 : 0, 0])
})
for (const field of ['getPublicKey', 'signEvent'] as const) test(`provider ${field} metadata revocation holds before actual discovery`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held')
  await page.evaluate(field => {
    const f = (window as any).providerFixture, original = f.provider[field]
    Object.defineProperty(f.provider, field, { get() {
      if (!f.cut) { f.cut = true; window.dispatchEvent(new PageTransitionEvent('pagehide')) }
      return original
    } })
  }, field)
  await startProvider(page); await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0, 0])
})
test('pagehide joins an actual pending SDK account discovery before releasing MIGRATION', async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account, true)
  await enter(page, href, 'captured-held'); await startProvider(page)
  await page.waitForFunction('providerFixture.started')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await providerState(page, 'held')
  expect(await page.evaluate('providerDone')).toBe(false)
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
  await page.evaluate('providerFixture.release();undefined'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerDone,providerFixture.calls,providerFixture.signs]')).toEqual([true, 1, 0])
})

for (const timing of ['before-discovery', 'pending-discovery'] as const) test(`authenticated native revision change ${timing} refuses stale provider handoff`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account, timing === 'pending-discovery')
  await enter(page, href, 'captured-held')
  if (timing === 'pending-discovery') { await startProvider(page); await page.waitForFunction('providerFixture.started') }
  // The explicit fixture seals a valid new frame through the actual codec;
  // application write/entropy probes stay installed throughout.
  await page.evaluate("import('/j/mutate-native.js').then(module=>module.advanceBrowserRevision())")
  expect(await page.evaluate('providerFixture.mutations')).toBe(1)
  if (timing === 'before-discovery') await startProvider(page)
  else await page.evaluate('providerFixture.release();undefined')
  await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([timing === 'before-discovery' ? 0 : 1, 0])
})
test('provider replacement during pending discovery cannot adopt the old result', async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account, true)
  await enter(page, href, 'captured-held'); await startProvider(page)
  await page.waitForFunction('providerFixture.started')
  await page.evaluate('providerFixture.current={...providerFixture.provider};providerFixture.release();undefined')
  await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
})
test('a failed provider witness cannot be reused after the account is corrected', async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, 'f'.repeat(64))
  await enter(page, href, 'captured-held'); await startProvider(page)
  await providerState(page, 'held'); await page.evaluate('providerOpening')
  const probes = await page.evaluate('probeNonces')
  await page.evaluate(account => { (window as any).providerFixture.account = account }, account)
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot())`)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,probeNonces]')).toEqual([1, 0, probes])
  expect(await lockAvailable(page, 'migration')).toBe(true)
})
test('expiry during actual pending discovery discards the late account and releases after it joins', async ({ page }) => {
  await page.clock.install()
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account, true)
  await enter(page, href, 'captured-held'); await startProvider(page)
  await page.waitForFunction('providerFixture.started')
  await page.clock.fastForward(1_201_000)
  await providerState(page, 'held')
  expect(await lockAvailable(page, 'migration')).toBe(false)
  await page.evaluate('providerFixture.release();undefined')
  await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
})

for (const mode of ['success', 'pending', 'reject'] as const) test(`actual SDK ${mode} close joins owners before MIGRATION release`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held')
  await page.evaluate(mode => { (window as any).providerFixture.closeMode = mode }, mode)
  await startProvider(page); await providerState(page, 'provider-held')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await providerState(page, 'held'); await page.waitForFunction('providerFixture.closeCalls===1')
  if (mode === 'pending') {
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    expect(await page.evaluate('providerFixture.closeTerminal')).toBeUndefined()
    await page.evaluate('providerFixture.closeRelease();undefined')
  }
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  expect(await page.evaluate('[providerFixture.closeCalls,providerFixture.closeTerminal,providerFixture.calls,providerFixture.signs]')).toEqual([1, true, 1, 0])
  if (mode === 'reject') await expect.poll(() => page.evaluate('window.__rootCloseFailure')).toBe('Explicit SDK close fixture rejection')
})
for (const timing of ['before', 'after'] as const) test(`pagehide ${timing} the provider resource assignment boundary joins late ownership`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held')
  await page.evaluate(timing => { (window as any).providerFixture.cutAssignment = timing }, timing)
  await startProvider(page); await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0, 0])
})
test('held provider expires without a new discovery or signing effect', async ({ page }) => {
  await page.clock.install()
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held'); await startProvider(page); await providerState(page, 'provider-held')
  await page.clock.fastForward(1_201_000); await providerState(page, 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot())`)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
})
for (const mutation of ['provider', 'native'] as const) test(`held ${mutation} mutation cannot turn cached discovery into a fresh handoff`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held'); await startProvider(page); await providerState(page, 'provider-held')
  if (mutation === 'provider') await page.evaluate('providerFixture.current={...providerFixture.provider}')
  else await page.evaluate("import('/j/mutate-native.js').then(module=>module.advanceBrowserRevision())")
  const probes = await page.evaluate('probeNonces')
  // Discovery is a cached historical checkpoint, not a current-state consumer.
  // Repeating it performs no handoff; future private consumption must re-read.
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot())`)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,probeNonces]')).toEqual([1, 0, probes])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})
