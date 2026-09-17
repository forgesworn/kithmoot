#!/usr/bin/env node
// A NIP-01 relay that loses call signalling on command.
//
// The same strict relay as test/ws-relay.mjs (signatures verified, ephemeral
// kinds delivered and never stored), minus the Blossom endpoint, plus a small
// HTTP control surface a spec drives while a call is up. Signalling content
// is encrypted, so faults are chosen by what a relay can actually see: the
// kind, the `p` tag naming the recipient device, and which socket published
// it - which names the sending device, because each device subscribes on
// the same socket with `#p` set to its own key.
//
//   RELAY_PORT=7781 node test/fault-relay.mjs
//
//   POST /fault {"dropKinds":[21059]}            drop every signal until cleared
//   POST /fault {"dropKinds":[]}                 stop dropping
//   POST /fault {"dropNext":{"to":"<hex>","from":"<hex>","count":1}}
//                                                drop the next N signals on that
//                                                directed pair, then deliver
//   POST /fault {"sockets":[3,4],"mode":"half-open"}
//                                                per socket: "half-open" (read nothing
//                                                from it, write nothing to it, never
//                                                close it), "no-ok" (process and forward
//                                                its events, never acknowledge them),
//                                                "no-ok-no-forward" (swallow its events
//                                                silently), or "healthy"
//   POST /fault {"newSocketMode":"half-open"}    the same, for every socket that connects
//                                                while set; null to stop
//   GET  /log                                    sockets, devices seen and every signal
//                                                wrap, with whether it was dropped

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { matchFilters } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'

const port = Number(process.env.RELAY_PORT ?? 7781)
const host = '127.0.0.1'
const SIGNAL_WRAP = 21059

const isEphemeral = (kind) => kind >= 20000 && kind < 30000
const stored = []
/** socket -> Map<subId, filters> */
const subscriptions = new Map()
/** socket -> numeric id, for the log */
const socketIds = new Map()
let nextSocket = 1
const started = Date.now()

let dropKinds = new Set()
/** socket id -> fault mode */
const socketModes = new Map()
/** Mode given to every socket that connects while this is set. */
let newSocketMode
/** socket id -> { connectedAt, events, oksWithheld, ignored } */
const socketInfo = new Map()
/** socket id -> socket, kept after close so devices stay attributable */
const socketById = new Map()
/** [{ to, from, count }] */
let dropNext = []
const log = []

/** The devices a socket listens for signals as. */
const everDevices = new Map()
function devicesOf(socket) {
  const out = new Set(everDevices.get(socket) ?? [])
  for (const filters of subscriptions.get(socket)?.values() ?? []) {
    for (const f of filters) {
      if (Array.isArray(f.kinds) && f.kinds.includes(SIGNAL_WRAP) && Array.isArray(f['#p'])) for (const p of f['#p']) out.add(p)
    }
  }
  everDevices.set(socket, out)
  return [...out]
}

function shouldDrop(event, socket) {
  if (dropKinds.has(event.kind)) return 'window'
  if (event.kind !== SIGNAL_WRAP) return false
  const to = event.tags.find((t) => t[0] === 'p')?.[1]
  const from = devicesOf(socket)
  const rule = dropNext.find((r) => r.count > 0 && r.to === to && (!r.from || from.includes(r.from)))
  if (!rule) return false
  rule.count -= 1
  return 'next'
}

const readBody = (req) => new Promise((resolve) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => resolve(raw))
})

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'POST' && url.pathname === '/fault') {
    const body = JSON.parse((await readBody(req)) || '{}')
    if (Array.isArray(body.dropKinds)) dropKinds = new Set(body.dropKinds)
    if (body.dropNext) dropNext.push({ ...body.dropNext, count: body.dropNext.count ?? 1 })
    if (body.clearNext) dropNext = []
    if ('newSocketMode' in body) newSocketMode = body.newSocketMode || undefined
    if (Array.isArray(body.sockets)) for (const id of body.sockets) {
      if (!body.mode || body.mode === 'healthy') socketModes.delete(id)
      else socketModes.set(id, body.mode)
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ dropKinds: [...dropKinds], dropNext }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/log') {
    const sockets = [...socketInfo].map(([id, info]) => {
      const s = socketById.get(id)
      return { socket: id, devices: s ? devicesOf(s) : [], subs: s ? subscriptions.get(s)?.size ?? 0 : 0, mode: socketModes.get(id) ?? 'healthy', ...info }
    })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sockets, signals: log, dropNext }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' }).end('kithmoot fault relay\n')
})
const wss = new WebSocketServer({ server: http })

const send = (socket, message) => {
  if (socketModes.get(socketIds.get(socket)) === 'half-open') return
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
}

wss.on('connection', (socket) => {
  subscriptions.set(socket, new Map())
  const id = nextSocket++
  socketIds.set(socket, id)
  socketById.set(id, socket)
  if (newSocketMode) socketModes.set(id, newSocketMode)
  socketInfo.set(id, { connectedAt: Date.now(), events: 0, oksWithheld: 0, ignored: 0 })
  socket.on('message', (raw) => {
    const info = socketInfo.get(id)
    const mode = socketModes.get(id)
    if (mode === 'half-open') { info.ignored++; return }
    let message
    try { message = JSON.parse(String(raw)) } catch { return }
    if (!Array.isArray(message)) return

    if (message[0] === 'EVENT') {
      const event = message[1]
      if (!event || typeof event !== 'object' || !verifyEvent(event)) {
        send(socket, ['OK', event?.id ?? '', false, 'invalid: bad signature'])
        return
      }
      info.events++
      const dropped = shouldDrop(event, socket) || (mode === 'no-ok-no-forward' ? 'socket' : false)
      if (event.kind === SIGNAL_WRAP) {
        log.push({
          ms: Date.now() - started,
          at: Date.now(),
          socket: socketIds.get(socket),
          from: devicesOf(socket).map((d) => d.slice(0, 8)),
          to: (event.tags.find((t) => t[0] === 'p')?.[1] ?? '').slice(0, 8),
          size: event.content.length,
          dropped: dropped || undefined,
        })
        if (log.length > 5000) log.shift()
      }
      // A lost signal is lost silently: the publisher still hears OK, which
      // is what a relay that accepted and failed to fan out looks like.
      if (!dropped) {
        if (!isEphemeral(event.kind) && !stored.some((e) => e.id === event.id)) stored.push(event)
        for (const [other, subs] of subscriptions) {
          for (const [subId, filters] of subs) {
            if (matchFilters(filters, event)) send(other, ['EVENT', subId, event])
          }
        }
      }
      if (mode === 'no-ok' || mode === 'no-ok-no-forward') { info.oksWithheld++; return }
      send(socket, ['OK', event.id, true, ''])
      return
    }

    if (message[0] === 'REQ') {
      const [, subId, ...filters] = message
      if (typeof subId !== 'string' || filters.length === 0) return
      subscriptions.get(socket)?.set(subId, filters)
      for (const event of stored) if (matchFilters(filters, event)) send(socket, ['EVENT', subId, event])
      send(socket, ['EOSE', subId])
      return
    }

    if (message[0] === 'CLOSE') subscriptions.get(socket)?.delete(message[1])
  })
  // A half-open socket is left open deliberately; a client closing it is
  // what a real one would see only after a timeout of its own.
  socket.on('close', () => { subscriptions.delete(socket); socketInfo.get(id).closedAt = Date.now() })
  socket.on('error', () => subscriptions.delete(socket))
})

http.listen(port, host, () => console.log(`kithmoot fault relay on ws://${host}:${port}`))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    wss.close()
    http.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 300).unref()
  })
}
