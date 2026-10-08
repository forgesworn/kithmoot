// Real local Bothy + Link acceptance. Start Vennel's claimed G5 fixture and
// pass its loopback control URL and WebPKI Link relay. No capability is logged.
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const control = process.env.LINK_BOTHY_CONTROL
const relay = process.env.LINK_TEST_RELAY
if (!control || new URL(control).hostname !== '127.0.0.1' || !relay?.startsWith('wss://')) throw new Error('Set loopback LINK_BOTHY_CONTROL and LINK_TEST_RELAY.')
const bundle = (await build({ entryPoints: ['test/browser-link.browser-entry.ts'], bundle: true, write: false,
  format: 'iife', globalName: 'L', target: 'es2022', define: { 'import.meta.env.BASE_URL': '"/j/"' } })).outputFiles[0].text
const server = createServer((req, res) => {
  const name = req.url.split('?')[0].split('/').at(-1)
  if (['link_web.js', 'link_web_bg.wasm'].includes(name)) {
    res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
    res.end(readFileSync(`app/public/link-web/${name}`))
  } else { res.setHeader('Content-Type', 'text/html'); res.end(`<script>${bundle}</script>`) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const monitor = new WebSocketServer({ server, path: '/monitor' })
monitor.on('connection', socket => socket.on('message', () => socket.close()))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${new URL(relay).hostname} 127.0.0.1`] })
const context = await browser.newContext({ ignoreHTTPSErrors: false })
const report = { pairing: false, authenticatedRoundTrip: false, restartRoundTrip: false, scopedGuest: false, revokedGuest: false, witnessRefusal: 0, publicRoomFrames: 0 }
try {
  const page = await context.newPage()
  page.on('websocket', socket => {
    console.error('relay websocket created')
    socket.on('socketerror', error => console.error('relay websocket error:', error))
    socket.on('close', () => console.error('relay websocket closed'))
  })
  page.on('websocket', socket => socket.on('framesent', frame => {
    if (typeof frame.payload === 'string' && /^\["(?:REQ|EVENT)"/.test(frame.payload)) report.publicRoomFrames++
  }))
  await page.goto(origin)
  await page.evaluate(url => new Promise(resolve => {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/monitor')
    socket.onopen = () => socket.send(JSON.stringify(['REQ','monitor-control',{kinds:[1460]}]))
    socket.onclose = () => resolve()
  }), origin)
  assert.equal(report.publicRoomFrames, 1, 'the frame monitor must detect its positive control')
  report.publicRoomFrames = 0
  console.error('carrier page loaded')
  const setup = async () => page.evaluate(async relay => {
    const sk = L.sha256(new TextEncoder().encode('kithmoot-g5-fixture-signer-v2:alice'))
    const pubkey = L.getPublicKey(sk)
    window.identity = { pubkey, signEvent: async e => L.finalizeEvent(e, sk) }
    window.link = new L.BrowserLink(L.startBrowserLink)
    await link.resume(pubkey, relay ? [relay] : undefined)
    window.scope = { room: 'a'.repeat(64), kinds: [1460] }
    window.roundTrip = async () => {
      const pool = new L.BrowserLinkRelay(link, link.boxes()[0], identity, scope)
      const event = await identity.signEvent({ kind: 1460, created_at: Math.floor(Date.now() / 1000), content: crypto.randomUUID(), tags: [['d', scope.room]] })
      try {
        let received
        const got = new Promise((resolve, reject) => { received = resolve; setTimeout(() => reject(new Error('readback timeout')), 45_000) })
        pool.subscribe([{ ids: [event.id], kinds: [event.kind], '#d': [scope.room] }], e => { if (e.id === event.id) received(true) })
        await pool.publish(event)
        return await got
      } finally { pool.close() }
    }
  }, relay)
  await setup()
  console.error('engine started')
  const { uri } = await (await fetch(`${control}/pairing`, { method: 'POST' })).json()
  await page.evaluate(code => link.pair(code), uri); report.pairing = true
  console.error('paired')
  report.authenticatedRoundTrip = await page.evaluate(() => roundTrip())
  console.error('authenticated round trip')
  report.witnessRefusal = await page.evaluate(async () => {
    const response = await link.request({ routeId: link.boxes()[0].routeId, method: 'POST', path: '/vmls-witness/v1/read', authorization: '', body: new Uint8Array() })
    if (response.body.length !== 0 || response.status < 400) throw new Error('Expected a bare witness refusal')
    return response.status
  })
  // A second browser profile, freshly paired, receives only one room's grant.
  const guestContext = await browser.newContext()
  try {
    const guest = await guestContext.newPage(); await guest.goto(origin)
    guest.on('websocket', socket => socket.on('framesent', frame => {
      if (typeof frame.payload === 'string' && /^\["(?:REQ|EVENT)"/.test(frame.payload)) report.publicRoomFrames++
    }))
    const guestKey = await guest.evaluate(async relay => {
      const sk = crypto.getRandomValues(new Uint8Array(32))
      window.identity = { pubkey: L.getPublicKey(sk), signEvent: async e => L.finalizeEvent(e, sk) }
      window.link = new L.BrowserLink(L.startBrowserLink)
      await link.resume(identity.pubkey, [relay])
      return identity.pubkey
    }, relay)
    const { uri: guestCode } = await (await fetch(`${control}/pairing`, { method: 'POST' })).json()
    await guest.evaluate(code => link.pair(code), guestCode)
    await page.evaluate(async guestKey => {
      const box = link.boxes()[0], at = Math.floor(Date.now() / 1000)
      const terms = [['t','event-grant'], ['server', box.eventUrl], ['d', scope.room], ['p',guestKey], ['device',guestKey], ['grant',crypto.randomUUID().replaceAll('-','')],
        ['read','1460'], ['read','1462'], ['read','20461'], ['write','1460'], ['write','20461'], ['expiration',String(at+3600)]]
      window.revoked = await identity.signEvent({ kind:24242, created_at:at+1, content:'', tags:[...terms,['status','revoked']] })
      const active = await identity.signEvent({kind:24242, created_at:at, content:'', tags:[...terms,['status','active']]})
      const pool = new L.BrowserLinkRelay(link, box, identity, {room:scope.room,kinds:[24242]})
      try { await pool.publish(active) } finally { pool.close() }
    }, guestKey)
    report.scopedGuest = await guest.evaluate(async () => {
      const room = 'a'.repeat(64)
      window.pool = new L.BrowserLinkRelay(link, link.boxes()[0], identity, { room, kinds:[1460] })
      window.event = await identity.signEvent({kind:1460, created_at:Math.floor(Date.now()/1000), tags:[['d',room]], content:'scoped fixture'})
      const got = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('guest readback timeout')), 30_000)
        pool.subscribe([{ ids:[event.id], kinds:[event.kind], '#d':[room] }], () => { clearTimeout(timer); resolve(true) })
      })
      await pool.publish(event); return await got
    })
    await page.evaluate(async () => {
      const pool = new L.BrowserLinkRelay(link, link.boxes()[0], identity, {room:scope.room,kinds:[24242]})
      try { await pool.publish(revoked) } finally { pool.close() }
    })
    report.revokedGuest = await guest.evaluate(async () => {
      try { await pool.publish(await identity.signEvent({...event,created_at:event.created_at+1,content:'after revocation'})); return false }
      catch { return true } finally { pool.close(); await link.stop() }
    })
    assert.equal(report.scopedGuest, true); assert.equal(report.revokedGuest, true)
  } finally { await guestContext.close() }
  await page.evaluate(() => link.stop())
  assert.equal((await fetch(`${control}/restart`, { method: 'POST' })).ok, true)
  await page.reload(); await setup()
  report.restartRoundTrip = await page.evaluate(() => roundTrip())
  await page.evaluate(() => link.stop())
  assert.equal(report.publicRoomFrames, 0)
  assert.equal(report.authenticatedRoundTrip, true); assert.equal(report.restartRoundTrip, true)
  console.log(JSON.stringify({ ...report, passed: true }))
} finally { await context.close(); await browser.close(); monitor.close(); await new Promise(resolve => server.close(resolve)) }
