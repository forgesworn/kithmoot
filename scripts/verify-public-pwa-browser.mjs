import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'

const tag = process.argv[2]
if (!/^\d{8}T\d{6}Z$/.test(tag ?? '')) throw new Error('Exact publication timestamp required')
const evidence = path.resolve('release', 'public-browser-verification', tag)
await fs.mkdir(evidence, { recursive: true })
const runtime = path.join(evidence, `live-browser-runtime-${tag}`)
await fs.mkdir(runtime)
process.env.TMPDIR = runtime
const results = []
function check(value, message) { if (!value) throw new Error(message) }
try {
  for (const [engine, type] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await type.launch({ headless: true })
    try {
      for (const kind of ['fresh-legacy-arrival', 'existing-state-held']) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
        try {
          await context.addInitScript(() => {
            const counts = { providerReads: 0, sockets: 0, storageWrites: 0 }
            Object.defineProperty(window, '__vennelVerification', { value: counts })
            Object.defineProperty(window, 'nostr', { configurable: false, get() { counts.providerReads++; return undefined } })
            const NativeSocket = window.WebSocket
            window.WebSocket = class extends NativeSocket {
              constructor(...args) { counts.sockets++; super(...args) }
            }
            for (const name of ['setItem', 'removeItem', 'clear']) {
              const original = Storage.prototype[name]
              Storage.prototype[name] = function (...args) { counts.storageWrites++; return Reflect.apply(original, this, args) }
            }
          })
          const page = await context.newPage()
          const errors = []
          page.on('pageerror', error => errors.push(error.message))
          if (kind === 'existing-state-held') {
            const bootstrap = `https://kithmoot.forgesworn.dev/j/__vennel-verification-${tag}.html`
            await context.route(bootstrap, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated verification fixture</title>' }))
            await page.goto(bootstrap)
            await page.evaluate(() => new Promise((resolve, reject) => {
              const request = indexedDB.open('kithmoot-ordinary-state-v1', 1)
              request.onupgradeneeded = () => request.result.createObjectStore('owners')
              request.onerror = () => reject(request.error)
              request.onsuccess = () => {
                const db = request.result, tx = db.transaction('owners', 'readwrite')
                tx.objectStore('owners').put('isolated-native-sentinel', 'verification')
                tx.oncomplete = () => { db.close(); resolve() }
                tx.onabort = () => { db.close(); reject(tx.error) }
              }
            }))
          }
          const response = await page.goto(`https://kithmoot.forgesworn.dev/j/?vennel-verification=${tag}`, { waitUntil: 'domcontentloaded' })
          check(response?.status() === 200, engine + ' public HTML response')
          const expected = kind === 'existing-state-held' ? 'held' : 'ready'
          await page.waitForFunction(expected => document.documentElement.dataset.ordinaryStartup === expected, expected, { timeout: 30000 })
          const observed = await page.evaluate(async () => ({
            startup: document.documentElement.dataset.ordinaryStartup,
            notice: document.getElementById('ordinaryStartupNotice')?.textContent,
            noticeHidden: document.getElementById('ordinaryStartupNotice')?.hidden,
            title: document.title,
            counts: window.__vennelVerification,
            databaseNames: (await indexedDB.databases()).map(value => value.name).sort(),
            scriptResources: performance.getEntriesByType('resource').filter(value => value.initiatorType === 'script').map(value => value.name),
          }))
          check(observed.startup === expected && errors.length === 0, engine + ' startup/errors')
          if (kind === 'existing-state-held') {
            check(!observed.noticeHidden && observed.counts.providerReads === 0 &&
                  observed.counts.sockets === 0 && observed.counts.storageWrites === 0, engine + ' existing-state effect boundary')
            const sentinel = await page.evaluate(() => new Promise((resolve, reject) => {
              const request = indexedDB.open('kithmoot-ordinary-state-v1')
              request.onerror = () => reject(request.error)
              request.onsuccess = () => {
                const db = request.result, tx = db.transaction('owners', 'readonly')
                const value = tx.objectStore('owners').get('verification')
                value.onsuccess = () => { const result = value.result; db.close(); resolve(result) }
                value.onerror = () => { db.close(); reject(value.error) }
              }
            }))
            check(sentinel === 'isolated-native-sentinel', engine + ' saved native state preserved')
            observed.sentinelPreserved = true
          } else check(observed.noticeHidden, engine + ' legacy arrival visible')
          const screenshot = path.join(evidence, `live-pwa-${tag}-${engine}-${kind}.png`)
          await page.screenshot({ path: screenshot, fullPage: true })
          results.push({ engine, browserVersion: browser.version(), kind, observed, pageErrors: errors,
                         screenshot, screenshotSha256: crypto.createHash('sha256').update(await fs.readFile(screenshot)).digest('hex') })
          console.log(engine, kind, expected, 'passed')
        } finally { await context.close() }
      }
    } finally { await browser.close() }
  }
  const output = path.join(evidence, `live-pwa-browser-verification-${tag}.json`)
  await fs.writeFile(output, JSON.stringify({ at: new Date().toISOString(), publication: tag,
    class: 'Native browsers against actual public PWA. Existing-state case uses an isolated same-origin native IndexedDB fixture, not real user data or authenticated protected restoration.',
    results, passed: results.length, physicalAcceptance: false,
    protectedRestorationAccepted: false, productionMLS: false }, null, 2) + '\n', { flag: 'wx' })
  console.log(output)
} finally { await fs.rm(runtime, { recursive: true, force: true }) }
