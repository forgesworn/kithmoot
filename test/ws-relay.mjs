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
// property `wss://relay.trotters.cc` provides in the live run. Every event's
// signature is verified before it is accepted, as a real relay does.
//
//   node test/ws-relay.mjs            # ws://127.0.0.1:7777
//   RELAY_PORT=7778 node test/ws-relay.mjs
//
// A plain HTTP GET answers 200, which is what lets Playwright's `webServer`
// wait on it. Nothing here is a product: no persistence, no auth, no limits.

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { matchFilters } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'

const port = Number(process.env.RELAY_PORT ?? 7777)
const host = process.env.RELAY_HOST ?? '127.0.0.1'

const isEphemeral = (kind) => kind >= 20000 && kind < 30000
/** Every non-ephemeral event accepted, newest last. */
const stored = []
/** socket -> Map<subId, filters> */
const subscriptions = new Map()

const http = createServer((req, res) => {
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
      if (!isEphemeral(event.kind)) {
        if (!stored.some((e) => e.id === event.id)) stored.push(event)
      }
      send(socket, ['OK', event.id, true, ''])
      for (const [other, subs] of subscriptions) {
        for (const [subId, filters] of subs) {
          if (matchFilters(filters, event)) send(other, ['EVENT', subId, event])
        }
      }
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
