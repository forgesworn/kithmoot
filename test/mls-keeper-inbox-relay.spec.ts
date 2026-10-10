import { test, expect, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { verifyEventUncached } from '../src/verify.js'
const keeper = getPublicKey(new Uint8Array(32).fill(42))
let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-keeper-inbox-relay.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'M' })).outputFiles[0]!.text })
type Mode = 'plain' | 'public-challenge' | 'auth-required' | 'circle' | 'auth-refused' | 'stale-signer'
async function fixture(context: BrowserContext, mode: Mode) {
  const frames: any[][] = [], statements: boolean[] = []
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    response.end(request.url === '/fixture.js' ? bundle : '<script src="/fixture.js"></script>')
  })
  const server = new WebSocketServer({ server: http, path: '/events' })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('missing fixture address')
  const origin = `http://127.0.0.1:${address.port}`, url = `ws://127.0.0.1:${address.port}/events`
  const event = finalizeEvent({ kind: 1059, created_at: 950, content: 'ciphertext', tags: [['p', keeper]] }, new Uint8Array(32).fill(43))
  server.on('connection', socket => {
    let authenticated = false
    if (mode !== 'plain') socket.send(JSON.stringify(['AUTH', 'opaque-challenge']))
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); frames.push(frame)
      if (frame[0] === 'AUTH') {
        const signed = frame[1]
        statements.push(verifyEventUncached(signed) && signed.pubkey === keeper && signed.kind === 22242 && signed.created_at === 1_000 && signed.content === '' &&
          JSON.stringify(signed.tags) === JSON.stringify([['relay', url], ['challenge', 'opaque-challenge']]))
        authenticated = statements.at(-1)! && mode !== 'auth-refused'
        socket.send(JSON.stringify(['OK', signed.id, authenticated, authenticated ? '' : 'restricted: refused']))
      } else if (frame[0] === 'REQ') {
        if (mode === 'auth-required' && !authenticated) { socket.send(JSON.stringify(['CLOSED', frame[1], 'auth-required: identify'])); return }
        socket.send(JSON.stringify(['EVENT', frame[1], { ...event, content: 'forged', verified: true }]))
        socket.send(JSON.stringify(['EVENT', frame[1], event])); socket.send(JSON.stringify(['EOSE', frame[1]]))
      }
    })
  })
  const page = await context.newPage(); await page.goto(origin)
  return { page, url, frames, statements, event, close: async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
  } }
}
for (const mode of ['plain', 'public-challenge', 'auth-required', 'circle'] as const) test(`keeper stored page with a real local WebSocket: ${mode}`, async ({ context }) => {
  const f = await fixture(context, mode)
  try {
    const result = await f.page.evaluate(({ url, circle, auth }) => (window as any).M.page(url, circle, auth), { url: f.url, circle: mode === 'circle', auth: mode !== 'plain' })
    expect(result).toEqual({ complete: true, events: [JSON.parse(JSON.stringify(f.event))] })
    const queries = f.frames.filter(frame => frame[0] === 'REQ'), authentications = f.frames.filter(frame => frame[0] === 'AUTH')
    expect(queries).toHaveLength(mode === 'auth-required' ? 2 : 1)
    expect(queries[0]![2]).toEqual({ kinds: [1059], '#p': [keeper], since: 900, until: 1_000, limit: 64 })
    expect(authentications).toHaveLength(mode === 'circle' || mode === 'auth-required' ? 1 : 0)
    expect(f.statements.every(Boolean)).toBe(true)
    if (mode === 'circle') expect(f.frames[0]![0]).toBe('AUTH')
    if (mode === 'auth-required') expect(queries[1]![1]).not.toBe(queries[0]![1])
  } finally { await f.close() }
})
test('keeper circle authentication refusal discloses no stored-page filter', async ({ context }) => {
  const f = await fixture(context, 'auth-refused')
  try {
    expect(await f.page.evaluate(url => (window as any).M.page(url, true, true), f.url)).toEqual({ complete: false, events: [] })
    expect(f.frames.filter(frame => frame[0] === 'REQ')).toEqual([]); expect(f.statements).toEqual([true])
  } finally { await f.close() }
})
test('keeper inbox account invalidation withholds a late AUTH signature on the actual socket', async ({ context }) => {
  const f = await fixture(context, 'stale-signer')
  try {
    const result = f.page.evaluate(url => (window as any).M.page(url, true, true, true), f.url)
    await expect(f.page.locator('body')).toHaveAttribute('data-keeper-signing', 'waiting')
    await f.page.evaluate(() => { (window as any).M.stop(); (window as any).M.finishSigner() })
    expect(await result).toEqual({ complete: false, events: [] }); expect(f.frames).toEqual([])
  } finally { await f.close() }
})
