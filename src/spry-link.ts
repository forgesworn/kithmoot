import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'

export interface SpryControlEndpoint { publicKey: string; relays: string[] }
const hex = /^[a-f0-9]{64}$/
const keyBytes = (key: string) => Uint8Array.from(key.match(/../g)!.map(value => parseInt(value, 16)))

/** Only endpoints explicitly approved by the pairing flow may be contacted. */
export function parseSpryControl(value: string): SpryControlEndpoint {
  if (value.length > 2048) throw new Error('Invalid Spry address.')
  const uri = new URL(value)
  if (uri.protocol !== 'spry:' || !hex.test(uri.hostname) || uri.username || uri.password || uri.port || uri.hash || !['', '/'].includes(uri.pathname)) throw new Error('Invalid Spry address.')
  const relays: string[] = []
  for (const [name, value] of uri.searchParams) {
    if (name !== 'relay' || value.length > 256) throw new Error('Invalid Spry relay.')
    const url = new URL(value)
    if (url.protocol !== 'wss:' || !url.hostname.includes('.') || url.username || url.password || url.hash || url.search ||
      /^\[|^[0-9.]+$/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname)) throw new Error('Invalid Spry relay.')
    if (relays.includes(url.href)) throw new Error('Invalid Spry relay.')
    relays.push(url.href)
  }
  if (!relays.length || relays.length > 4) throw new Error('Invalid Spry relay.')
  return { publicKey: uri.hostname, relays: relays.sort() }
}
function tag(event: Event, name: string): string | undefined {
  const found = event.tags.filter(tag => tag[0] === name)
  return found.length === 1 && found[0].length === 2 ? found[0][1] : undefined
}
export function spryNodeCard(value: unknown, now = Math.floor(Date.now() / 1000)): Event | undefined {
  try {
    if (!value || typeof value !== 'object' || JSON.stringify(value).length > 2048) return undefined
    const event = value as Event
    if (event.kind !== 24183 || !Number.isSafeInteger(event.created_at) || event.created_at > now + 60 ||
      typeof event.content !== 'string' || event.content.length > 256 || !Array.isArray(event.tags) || event.tags.length > 8 || !verifyEvent(event)) return undefined
    const expiry = Number(tag(event, 'expiration'))
    if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + 660 || expiry > event.created_at + 600) return undefined
    const content = JSON.parse(event.content)
    if (content.v !== 1 || content.profile !== 'spry-peer-v1' || typeof content.address !== 'string' || !/^\[(?:fc|fd)[a-fA-F0-9:]+\]:3745$/.test(content.address)) return undefined
    // URL's IPv6 parser rejects invalid groups, zone IDs and mapped addresses.
    new URL(`http://${content.address}`)
    return { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, content: event.content,
      tags: event.tags.map(tag => [...tag]), sig: event.sig }
  } catch { return undefined }
}

/** Signed NIP-44 control, pinned to the node identity selected during pairing. */
export async function spryControlRequest(endpoint: string, path: string, body: object, secret: string,
  now = Math.floor(Date.now() / 1000), socketFactory = (url: string): WebSocket => new WebSocket(url)): Promise<Record<string, unknown>> {
  const target = parseSpryControl(endpoint)
  if (!hex.test(secret) || JSON.stringify(body).length > 8192) throw new Error('Invalid Spry request.')
  const key = keyBytes(secret), pubkey = getPublicKey(key), conversation = getConversationKey(key, target.publicKey)
  const request = finalizeEvent({ kind: 24181, created_at: now, tags: [['p', target.publicKey], ['expiration', String(now + 30)]],
    content: encrypt(JSON.stringify({ v: 1, path, body }), conversation) }, key)
  return new Promise((resolve, reject) => {
    const sockets: WebSocket[] = []
    let finished = false
    const timer = setTimeout(() => finish(undefined), 10000)
    function finish(value: Record<string, unknown> | undefined): void {
      if (finished) return
      finished = true; clearTimeout(timer)
      for (const socket of sockets) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; socket.close() }
      if (value) resolve(value)
      else reject(new Error('Spry could not connect. Check the pairing in Connections and try again.'))
    }
    for (const relay of target.relays) {
      let socket: WebSocket
      try { socket = socketFactory(relay) } catch { continue }
      sockets.push(socket)
      let count = 0, auth: string | undefined, challenges = 0, publications = 0
      const subscribe = () => socket.send(JSON.stringify(['REQ', 'spry-reply', { kinds: [24182], '#p': [pubkey], '#e': [request.id], since: now - 60, limit: 8 }]))
      socket.onopen = subscribe
      socket.onmessage = message => {
        try {
          if (typeof message.data !== 'string' || message.data.length > 25088 || ++count > 64) { socket.close(); return }
          const frame = JSON.parse(message.data)
          if (frame[0] === 'AUTH' && typeof frame[1] === 'string' && frame[1].length <= 256 && ++challenges <= 4) {
            const proof = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['relay', relay], ['challenge', frame[1]]] }, key)
            auth = proof.id; socket.send(JSON.stringify(['AUTH', proof])); return
          }
          if (frame[0] === 'OK' && frame[1] === auth && frame[2] === true) { auth = undefined; subscribe(); return }
          if (frame[0] === 'EOSE' && frame[1] === 'spry-reply' && !auth && ++publications <= 4) { socket.send(JSON.stringify(['EVENT', request])); return }
          if (frame[0] !== 'EVENT' || frame[1] !== 'spry-reply') return
          const event = frame[2] as Event, current = Math.floor(Date.now() / 1000)
          if (!event || event.pubkey !== target.publicKey || event.kind !== 24182 || !Number.isSafeInteger(event.created_at) || event.created_at > current + 60 ||
            !Array.isArray(event.tags) || event.tags.length > 8 || tag(event, 'p') !== pubkey || tag(event, 'e') !== request.id ||
            !Number.isSafeInteger(Number(tag(event, 'expiration'))) || Number(tag(event, 'expiration')) <= current ||
            Number(tag(event, 'expiration')) > Math.min(current + 90, event.created_at + 30) || !verifyEvent(event)) return
          const result = JSON.parse(decrypt(event.content, conversation))
          if (result.v !== 1 || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || !result.body || typeof result.body !== 'object' || Array.isArray(result.body) || JSON.stringify(result.body).length > 8192) return
          finish(result.status === 200 ? result.body : undefined)
        } catch { /* Ignore malformed or unauthenticated relay traffic. */ }
      }
      socket.onerror = () => socket.close()
    }
  })
}
