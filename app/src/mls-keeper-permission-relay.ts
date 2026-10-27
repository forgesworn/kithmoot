import type { Event } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { authenticatedWebSocket } from '../../src/relay-auth.js'
import { readKeeperInboxPermission } from './mls-keeper-permissions.js'

/** Account-authenticated installation over a mandatory dedicated Link factory. */
export async function publishKeeperInboxPermission(event: Event, identity: ParticipantIdentity, current: () => boolean,
  factory: (url: string) => WebSocket, now: () => number = () => Math.floor(Date.now() / 1000),
  budgets = { open: 30_000, auth: 75_000, ack: 5_000 }): Promise<void> {
  const status = event.tags.find(t => t[0] === 'status')?.[1]
  if (status !== 'active' && status !== 'revoked') throw new Error('Invalid keeper permission status.')
  const terms = readKeeperInboxPermission(event, now(), status)
  if (identity.pubkey !== terms.keeper || typeof factory !== 'function' || Object.entries({ open: 30_000, auth: 75_000, ack: 5_000 }).some(([key, maximum]) => !Number.isSafeInteger(budgets[key as keyof typeof budgets]) || budgets[key as keyof typeof budgets] < 1 || budgets[key as keyof typeof budgets] > maximum)) throw new Error('Use the selected keeper account and private route.')
  const destination = terms.event.tags.find(t => t[0] === 'server')![1]!, signer = identity.signEvent.bind(identity)
  let floor = now()
  return new Promise<void>((resolve, reject) => {
    let finished = false, phase: 'open' | 'auth' | 'ack' = 'open', frames = 0, chars = 0, socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout>, guard: ReturnType<typeof setInterval>
    const live = () => { try { const selected = current() === true, at = now(); if (!selected || !Number.isSafeInteger(at) || at < floor || at >= terms.expiration) return false; floor = at; return !finished } catch { return false } }
    const finish = (ok = false) => {
      if (finished) return
      const accepted = ok && phase === 'ack' && live()
      finished = true; clearTimeout(timer); clearInterval(guard); try { socket?.close() } catch {}
      accepted ? resolve() : reject(new Error('The permission was not node-acknowledged. Exact saved material remains available for explicit retry or revocation.'))
    }
    const arm = (next: typeof phase) => { phase = next; clearTimeout(timer); timer = setTimeout(() => finish(), budgets[next]) }
    class BoundedSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      onopen: ((e: unknown) => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      onclose: ((e: unknown) => void) | null = null
      readonly raw: WebSocket
      constructor(readonly url: string) {
        if (!live() || url !== destination) throw new Error('Private permission route changed.')
        this.raw = factory(url)
        this.raw.onopen = e => { if (!live()) { finish(); return }; arm('auth'); this.onopen?.(e) }
        this.raw.onmessage = e => { if (!live() || typeof e.data !== 'string' || e.data.length > 4096 || ++frames > 32 || (chars += e.data.length) > 32768) { finish(); return }; this.onmessage?.({ data: e.data }) }
        this.raw.onerror = e => this.onerror?.(e); this.raw.onclose = e => this.onclose?.(e)
      }
      get readyState() { return this.raw.readyState }
      send(text: string) { if (!live()) throw new Error('Private permission operation changed.'); this.raw.send(text) }
      close() { this.raw.close() }
    }
    const grant = { pubkey: terms.keeper, sign: async (template: Parameters<ParticipantIdentity['signEvent']>[0]) => {
      if (!live()) throw new Error('Keeper operation changed.')
      const signed = await signer(template)
      if (!live()) throw new Error('Keeper operation changed.')
      return signed
    } }
    const Authenticated = authenticatedWebSocket(BoundedSocket as unknown as typeof WebSocket,
      () => grant, () => live(), () => finish(), budgets.auth)
    if (!live()) { finish(); return }
    arm('open'); guard = setInterval(() => { if (!live()) finish() }, 25)
    try {
      socket = new Authenticated(destination)
      socket.onopen = () => { if (!live()) { finish(); return }; arm('ack'); socket!.send(JSON.stringify(['EVENT', terms.event])) }
      socket.onerror = () => finish(); socket.onclose = () => finish()
      socket.onmessage = message => { if (!live() || phase !== 'ack') { finish(); return }; try { const frame = JSON.parse(message.data); if (Array.isArray(frame) && frame[0] === 'OK' && frame[1] === terms.event.id) finish(frame.length === 4 && frame[2] === true && typeof frame[3] === 'string') } catch { finish() } }
    } catch { finish() }
  })
}
