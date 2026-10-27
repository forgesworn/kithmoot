import type { Event } from 'nostr-tools/pure'
import { verifyEventUncached } from '../../src/verify.js'
import { keeperInboxAuthRequest, keeperInboxDestination, keeperInboxPermissionDevice, keeperInboxPermissionLive,
  type KeeperInboxAuthRequest } from './mls-keeper-inbox-auth.js'

export interface MlsKeeperInboxDeposit {
  box: string
  keeper: string
  permission: Event
  event: Event
  current(): boolean
  /** The concrete owner signs and accepts a purpose-specific vault reply. */
  authenticate(request: KeeperInboxAuthRequest): Promise<Event>
  /** Reaccept the original opaque vault reply after AUTH OK, before EVENT. */
  beforePublish(): Promise<void>
  signal?: AbortSignal
}
export interface MlsKeeperInboxDepositBudgets { openMs: number; authMs: number; ackMs: number }
export const MLS_KEEPER_DEPOSIT_BUDGETS = Object.freeze({ openMs: 30_000, authMs: 75_000, ackMs: 5_000 })
const HEX = /^[0-9a-f]{64}(?![\s\S])/
const SIG = /^[0-9a-f]{128}(?![\s\S])/
const epoch = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const encoder = new TextEncoder()

function wrapSnapshot(value: Event, keeper: string, now: number): Event | undefined {
  if (!value || value.kind !== 1059 || !epoch(value.created_at) || value.created_at > now + 600 ||
      value.created_at < Math.max(0, now - 2 * 86400 - 600) || typeof value.content !== 'string' ||
      !value.content.length || value.content.length > 40_000 || encoder.encode(value.content).length > 40_000 ||
      !HEX.test(value.id) || !HEX.test(value.pubkey) || !SIG.test(value.sig) || !Array.isArray(value.tags) ||
      value.tags.length !== 1 || !Array.isArray(value.tags[0]) || value.tags[0].length !== 2 ||
      value.tags[0][0] !== 'p' || value.tags[0][1] !== keeper) return
  const event: Event = { id: value.id, pubkey: value.pubkey, sig: value.sig, kind: 1059,
    created_at: value.created_at, content: value.content, tags: [['p', keeper]] }
  if (!verifyEventUncached(event)) return
  Object.freeze(event.tags[0]); Object.freeze(event.tags)
  return Object.freeze(event)
}

/** A finite deposit protocol over a mandatory owner-supplied socket. This
 * function cannot select a public socket, directory or fallback. The concrete
 * endpoint must bind the factory to its saved, authenticated private Link route.
 * A receipt means the node ACKed storage; it grants no membership or action. */
export async function publishMlsKeeperInboxDeposit(input: MlsKeeperInboxDeposit,
  socketFactory: (url: string) => WebSocket,
  now: () => number = () => Math.floor(Date.now() / 1000),
  phases: MlsKeeperInboxDepositBudgets = MLS_KEEPER_DEPOSIT_BUDGETS): Promise<void> {
  const budgets = Object.freeze({ ...phases })
  if (typeof socketFactory !== 'function' || typeof input?.current !== 'function' || typeof input.authenticate !== 'function' || typeof input.beforePublish !== 'function' ||
      Object.entries(MLS_KEEPER_DEPOSIT_BUDGETS).some(([k, max]) => {
        const value = budgets[k as keyof MlsKeeperInboxDepositBudgets]
        return !Number.isSafeInteger(value) || value < 1 || value > max
      })) throw new Error('Invalid private keeper deposit.')
  const started = now()
  if (!epoch(started)) throw new Error('Invalid private keeper deposit time.')
  // Preflight only: this placeholder is never signed or sent. The actual
  // authentication callback receives only this connection's fresh challenge.
  const binding = keeperInboxAuthRequest({ v: 1, box: input.box, keeper: input.keeper,
    permission: input.permission, challenge: '0'.repeat(64), expires_at: started + 120 })
  const event = binding && wrapSnapshot(input.event, binding.keeper, started)
  if (!binding || !event || !keeperInboxPermissionLive(binding, started)) throw new Error('Invalid private keeper deposit binding.')
  const current = input.current.bind(input), authenticate = input.authenticate.bind(input), beforePublish = input.beforePublish.bind(input), signal = input.signal
  const destination = keeperInboxDestination(binding.box), device = keeperInboxPermissionDevice(binding)
  let finished = false, socket: WebSocket | undefined, floor = started
  return new Promise<void>((resolve, reject) => {
    let phase: 'open' | 'auth' | 'ready' | 'ack' = 'open', expires = 0
    let timer: ReturnType<typeof setTimeout> | undefined, guard: ReturnType<typeof setInterval> | undefined
    let challenge: string | undefined, authId: string | undefined, frames = 0, chars = 0
    const active = () => {
      try {
        if (finished || signal?.aborted || current() !== true || finished || signal?.aborted) return false
        const at = now()
        if (!epoch(at) || at < floor || !keeperInboxPermissionLive(binding, at)) return false
        floor = at
        return true
      } catch { return false }
    }
    const inBudget = () => performance.now() < expires
    const finish = (accepted: boolean) => {
      if (finished) return
      const confirmed = accepted && phase === 'ack' && active() && inBudget()
      finished = true
      clearTimeout(timer); clearInterval(guard); signal?.removeEventListener('abort', abort)
      try { socket?.close() } catch { /* No later effect can change this result. */ }
      if (confirmed) resolve()
      else reject(new Error('Private keeper deposit was not confirmed.'))
    }
    const abort = () => finish(false)
    const arm = (next: 'open' | 'auth' | 'ack') => {
      phase = next
      expires = performance.now() + (next === 'open' ? budgets.openMs : next === 'auth' ? budgets.authMs : budgets.ackMs)
      clearTimeout(timer); timer = setTimeout(() => finish(false), Math.max(0, expires - performance.now()))
    }
    const authorize = async (fresh: string) => {
      try {
        const at = now()
        const request = keeperInboxAuthRequest({ v: 1, box: binding.box, keeper: binding.keeper,
          permission: binding.permission, challenge: fresh, expires_at: at + 120 })
        if (!request || !active() || !inBudget()) { finish(false); return }
        const signed = await authenticate(request)
        if (!active() || !inBudget() || phase !== 'auth') { finish(false); return }
        const expected = { kind: 22242, content: '', tags: [['relay', destination], ['challenge', fresh]] }
        if (!signed || signed.pubkey !== device || signed.kind !== expected.kind || signed.content !== '' ||
            !epoch(signed.created_at) || Math.abs(signed.created_at - now()) > 600 ||
            JSON.stringify(signed.tags) !== JSON.stringify(expected.tags)) { finish(false); return }
        const auth: Event = { ...expected, created_at: signed.created_at, id: signed.id, pubkey: signed.pubkey, sig: signed.sig }
        if (!verifyEventUncached(auth) || !active() || !inBudget()) { finish(false); return }
        authId = auth.id
        socket!.send(JSON.stringify(['AUTH', auth]))
      } catch { finish(false) }
    }
    const publish = async () => {
      try {
        // This recheck shares the remaining AUTH budget; storage confirmation
        // gets its own fresh budget only once EVENT is actually sent.
        await beforePublish()
        if (!active() || !inBudget() || phase !== 'ready') { finish(false); return }
        arm('ack')
        if (!active()) { finish(false); return }
        socket!.send(JSON.stringify(['EVENT', event]))
      } catch { finish(false) }
    }
    if (!active()) { finish(false); return }
    arm('open')
    guard = setInterval(() => { if (!active()) finish(false) }, 25)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      socket = socketFactory(destination)
      socket.onopen = () => {
        if (!active() || !inBudget() || phase !== 'open') { finish(false); return }
        arm('auth')
      }
      socket.onerror = () => finish(false)
      socket.onclose = () => finish(false)
      socket.onmessage = message => {
        if (!active() || !inBudget() || phase === 'open') { finish(false); return }
        if (++frames > 32 || typeof message.data !== 'string' || message.data.length > 4096 ||
            (chars += message.data.length) > 32_768) { finish(false); return }
        try {
          const frame: unknown = JSON.parse(message.data)
          if (!Array.isArray(frame)) { finish(false); return }
          if (frame[0] === 'AUTH') {
            if (phase !== 'auth' || frame.length !== 2 || typeof frame[1] !== 'string' || !HEX.test(frame[1]) ||
                challenge !== undefined && challenge !== frame[1]) { finish(false); return }
            if (challenge === undefined) { challenge = frame[1]; void authorize(challenge) }
          } else if (frame[0] === 'OK' && frame[1] === authId && authId && phase === 'auth') {
            if (frame.length !== 4 || frame[2] !== true || typeof frame[3] !== 'string') { finish(false); return }
            if (!active() || !inBudget()) { finish(false); return }
            phase = 'ready'
            void publish()
          } else if (frame[0] === 'OK' && frame[1] === event.id && phase === 'ack') {
            finish(frame.length === 4 && frame[2] === true && typeof frame[3] === 'string')
          } else if (frame[0] === 'NOTICE' || frame[0] === 'CLOSED') finish(false)
        } catch { finish(false) }
      }
    } catch { finish(false) }
  })
}
