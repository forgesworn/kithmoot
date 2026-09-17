#!/usr/bin/env node
// A NIP-01 relay for the acceptance tests, over a real WebSocket.
//
// The Playwright specs drive the built app in a real browser, and the app
// talks to relays over `wss://` - so the in-process `SimRelay` behind the
// `RelayTransport` seam cannot reach it. Running them against public relays
// is right for the live check and wrong for CI: real relays have real
// weather, and a gate that fails on somebody else's outage is a gate people
// learn to ignore. This is the relay CI runs against instead.
//
// It is strict in the one way that matters to these tests: ephemeral kinds
// (20000-29999) are delivered to open subscriptions and never stored, so a
// device that subscribes late learns nothing from the relay - which is the
// property the announce-and-answer roster is built to survive, and the
// property the live run's relays provide. Every event's
// signature is verified before it is accepted, as a real relay does.
//
//   node test/ws-relay.mjs            # ws://127.0.0.1:7777
//   RELAY_PORT=7778 node test/ws-relay.mjs
//
// A plain HTTP GET answers 200, which is what lets Playwright's `webServer`
// wait on it. The same test-only server accepts encrypted Blossom uploads in
// memory, capped at the production endpoint's 270 MiB request limit. Nothing
// here is a product or a persistent store.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { matchFilters } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'

const port = Number(process.env.RELAY_PORT ?? 7777)
const host = process.env.RELAY_HOST ?? '127.0.0.1'
/**
 * How long to hold the OK for an accepted event, in milliseconds. Zero, the
 * default, acknowledges at once.
 *
 * A real relay delivers an event to its subscribers and acknowledges it to
 * its publisher at about the same moment, but the publisher only hears the
 * OK a network round trip later - and nostr-tools does not resolve a publish
 * until it does. On a loopback socket that round trip is under a millisecond,
 * which is why no race that lives in it ever shows on this relay. Holding
 * the OK back, with delivery untouched, is that round trip made large and
 * deterministic: whatever a client does *after* its publish resolves is
 * measurably late, and whatever the room does in reply is measurably early.
 */
const okDelayMs = Number(process.env.RELAY_OK_DELAY_MS ?? 0)

const isEphemeral = (kind) => kind >= 20000 && kind < 30000
/** Every non-ephemeral event accepted, newest last. */
const stored = []
/** socket -> Map<subId, filters> */
const subscriptions = new Map()
/** Encrypted envelopes accepted by the test-only Blossom endpoint. The
 * browser reaches this through Vite's HTTPS preview proxy, so WebKit sends a
 * real streamed request instead of a Playwright route mock trying to inspect
 * a body WebKit deliberately does not expose to automation. */
const blobs = new Map()
const MAX_BLOB_BYTES = 270 * 1024 * 1024

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (req.method === 'PUT' && url.pathname === '/upload') {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BLOB_BYTES) {
        res.writeHead(413).end()
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (res.headersSent) return
      const bytes = Buffer.concat(chunks)
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (req.headers['x-sha-256'] !== hash) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('hash mismatch')
        return
      }
      blobs.set(hash, bytes)
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : 'https://localhost:4173'
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sha256: hash, size: bytes.length, url: `${origin}/blossom/${hash}` }))
    })
    req.on('error', () => {
      if (!res.headersSent) res.writeHead(400).end()
    })
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/blossom/')) {
    const hash = url.pathname.slice('/blossom/'.length)
    const bytes = blobs.get(hash)
    if (!bytes) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.forgesworn.encrypted',
      'content-length': String(bytes.length),
    })
    res.end(bytes)
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('kithmoot test relay\n')
})
const wss = new WebSocketServer({ server: http })

const send = (socket, message) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
}

wss.on('connection', (socket) => {
  subscriptions.set(socket, new Map())
  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      send(socket, ['NOTICE', 'invalid: not JSON'])
      return
    }
    if (!Array.isArray(message)) return

    if (message[0] === 'EVENT') {
      const event = message[1]
      if (!event || typeof event !== 'object' || !verifyEvent(event)) {
        send(socket, ['OK', event?.id ?? '', false, 'invalid: bad signature'])
        return
      }
      // NIP-09, as relays that honour it do: a kind 5 removes the named events
      // by the same author, by id or by address, and is itself kept.
      if (event.kind === 5) {
        const ids = new Set(event.tags.filter((t) => t[0] === 'e').map((t) => t[1]))
        const addresses = new Set(event.tags.filter((t) => t[0] === 'a').map((t) => t[1]))
        for (let i = stored.length - 1; i >= 0; i--) {
          const e = stored[i]
          if (e.pubkey !== event.pubkey || e.kind === 5) continue
          const address = `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`
          if (ids.has(e.id) || (addresses.has(address) && e.created_at <= event.created_at)) stored.splice(i, 1)
        }
      }
      if (!isEphemeral(event.kind)) {
        if (!stored.some((e) => e.id === event.id)) stored.push(event)
      }
      // Delivered first, acknowledged second - and, when asked, late. See
      // `okDelayMs`.
      for (const [other, subs] of subscriptions) {
        for (const [subId, filters] of subs) {
          if (matchFilters(filters, event)) send(other, ['EVENT', subId, event])
        }
      }
      const ok = () => send(socket, ['OK', event.id, true, ''])
      if (okDelayMs > 0) setTimeout(ok, okDelayMs)
      else ok()
      return
    }

    if (message[0] === 'REQ') {
      const [, subId, ...filters] = message
      if (typeof subId !== 'string' || filters.length === 0) return
      subscriptions.get(socket)?.set(subId, filters)
      for (const event of stored) {
        if (matchFilters(filters, event)) send(socket, ['EVENT', subId, event])
      }
      send(socket, ['EOSE', subId])
      return
    }

    if (message[0] === 'CLOSE') {
      subscriptions.get(socket)?.delete(message[1])
    }
  })
  socket.on('close', () => subscriptions.delete(socket))
  socket.on('error', () => subscriptions.delete(socket))
})

http.listen(port, host, () => {
  console.log(`kithmoot test relay listening on ws://${host}:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    wss.close()
    http.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  })
}
