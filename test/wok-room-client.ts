import NodeWebSocket from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils.js'
import { BrowserRoomActivation } from '../app/src/browser-room-activation.js'
import { StandaloneRoomConnection } from '../app/src/standalone-room-connection.js'
import { TextRoomRelay } from '../app/src/browser-room-routes.js'
import { validateConsent, type RoomConsent } from '../app/src/browser-room-consent.js'
import type { BrowserLink } from '../app/src/browser-link.js'
import type { ParticipantIdentity } from '../src/identity.js'

function identity(secret: Uint8Array): ParticipantIdentity {
  return { pubkey: getPublicKey(secret), signEvent: async event => finalizeEvent(event, secret) }
}

function memoryStore() {
  let consent: RoomConsent | undefined
  return {
    all: async () => consent ? [structuredClone(consent)] : [],
    put: async (next: RoomConsent) => { validateConsent(next); consent = structuredClone(next) },
    get: () => consent,
  }
}

export async function runWokRoomAcceptance({ server, port, keeperSecret, restart, directWss = false }: {
  server: string
  port: number
  keeperSecret: string
  restart: () => Promise<void>
  directWss?: boolean
}) {
  const room = '11'.repeat(32)
  const keeper = identity(hexToBytes(keeperSecret))
  const guest = identity(generateSecretKey()), keeperDevice = generateSecretKey(), guestDevice = generateSecretKey()
  const connection = () => {
    class LocalSocket extends NodeWebSocket {
      constructor(url: string) {
        if (directWss) {
          super(url, { lookup: (_hostname, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4), rejectUnauthorized: false })
          return
        }
        const target = new URL(url)
        target.protocol = 'ws:'
        target.host = `127.0.0.1:${port}`
        super(target.toString())
      }
    }
    const result = new StandaloneRoomConnection(undefined, LocalSocket as unknown as typeof globalThis.WebSocket)
    result.configure(server)
    return result
  }
  const activation = (who: ParticipantIdentity, store: ReturnType<typeof memoryStore>) => new BrowserRoomActivation(() => who,
    connection() as unknown as BrowserLink, store, { changed: () => {}, closed: async (_room, work) => work() },
    undefined, undefined, async (_room, work) => work())
  const readiness = (device: Uint8Array) => async () => finalizeEvent({ kind: 20461, content: 'encrypted presence fixture',
    created_at: Math.floor(Date.now() / 1000), tags: [['d', room]] }, device)
  const keeperStore = memoryStore(), guestStore = memoryStore()
  const keeperActivation = activation(keeper, keeperStore)
  await keeperActivation.activate({ room, box: connection().boxes()[0]!, device: getPublicKey(keeperDevice), scopes: [room], aliases: [],
    guests: [{ persona: guest.pubkey, device: getPublicKey(guestDevice) }], readiness: readiness(keeperDevice) })
  const guestActivation = activation(guest, guestStore)
  await guestActivation.activate({ room, box: connection().boxes()[0]!, device: getPublicKey(guestDevice), scopes: [room], aliases: [],
    readiness: readiness(guestDevice) })
  const consent = guestStore.get()!
  const publishAndRead = async (text: string, stream = room, carried = consent) => {
    const relay = new TextRoomRelay(connection(), carried, guest)
    try {
      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Scoped room readback timed out.')), 10_000)
        const stop = relay.subscribe([{ kinds: [1460], '#d': [stream] }], event => {
          if (event.content === text) { clearTimeout(timer); stop(); resolve(event.id) }
        })
      })
      const event = finalizeEvent({ kind: 1460, content: text, created_at: Math.floor(Date.now() / 1000), tags: [['d', stream]] }, guestDevice)
      await relay.publish(event)
      return await received
    } finally { relay.close() }
  }
  const refusedOn = async (stream: string, carried: RoomConsent) => {
    const relay = new TextRoomRelay(connection(), carried, guest)
    try {
      await relay.publish(finalizeEvent({ kind: 1460, content: 'must not be accepted', created_at: Math.floor(Date.now() / 1000), tags: [['d', stream]] }, guestDevice))
      return false
    } catch { return true } finally { relay.close() }
  }
  const first = await publishAndRead('encrypted room fixture one')
  await restart()
  const second = await publishAndRead('encrypted room fixture two')

  // The room's board, added in place to a route activated without it. A member who adds it to their own selection
  // before the keeper has granted it is refused by the box; once the keeper renews for the same devices and the member
  // activates again, a board part of full size (about 45 KB) is carried and read back on the board's own stream.
  const board = '22'.repeat(32)
  const boardRefusedEarly = await refusedOn(board, { ...consent, scopes: [room, board] })
  await keeperActivation.renew(room, readiness(keeperDevice), [room, board])
  await guestActivation.activate({ room, box: connection().boxes()[0]!, device: getPublicKey(guestDevice), scopes: [room, board], aliases: [],
    readiness: readiness(guestDevice) })
  const upgraded = guestStore.get()!
  if (JSON.stringify(upgraded.scopes) !== JSON.stringify([room, board])) throw new Error('The member’s selection did not gain the board.')
  if (keeperStore.get()!.grants.filter(g => g.active.tags.some(t => t[0] === 'd' && t[1] === board)).length !== 2) throw new Error('The keeper did not grant the board to both devices.')
  const boardPart = `board part ${'x'.repeat(45_000)}`
  const boardCarried = !!await publishAndRead(boardPart, board, upgraded)

  await keeperActivation.renew(room, readiness(keeperDevice))
  await keeperActivation.withdraw(room)
  const refused = await refusedOn(room, consent)
  if (!refused) throw new Error('A withdrawn grant still accepted room traffic.')
  const boardWithdrawn = await refusedOn(board, upgraded)
  return { activated: true, scopedReadback: first !== second, restart: true, renewed: true, withdrawn: refused,
    board: { refusedBeforeTheKeeper: boardRefusedEarly, carried: boardCarried, withdrawn: boardWithdrawn } }
}
