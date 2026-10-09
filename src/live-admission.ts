import { generateSecretKey } from 'nostr-tools/pure'
import {
  deriveInvitationId, encodeLivePersistentRequest, decodeLivePersistentAnswer,
  parseLivePersistentEvent, decodeInvitationRetirementNotice, retirementError,
  type LivePersistentContext, type LivePersistentAnswer,
} from '@forgesworn/fold-kit'
import type { RelayTransport } from './relay-pool.js'

const active = new Set<string>()
const HEX = /^[0-9a-f]{64}$/
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export interface LiveAdmissionOptions extends LivePersistentContext {
  transport: RelayTransport
  /** Stable local device public key. It is not sent in the challenge. */
  ownerDevice: string
  signal?: AbortSignal
  now?: () => number
  monotonic?: () => number
  /** The embedding's already-known retirement state, never a cache completeness claim. */
  retired?: () => boolean
}

/** One disposable exchange on a caller-owned route. Never constructs or closes a transport. */
export function requestLivePersistentAdmission(opts: LiveAdmissionOptions): Promise<LivePersistentAnswer> {
  const owner = `${opts.ownerDevice}:${opts.roomId}`
  if (!HEX.test(opts.ownerDevice) || active.has(owner) || active.size >= 8) return Promise.reject(new Error('live admission owner unavailable'))
  if (opts.signal?.aborted) return Promise.reject(new Error('live admission cancelled'))
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const monotonic = opts.monotonic ?? (() => performance.now())
  const key = generateSecretKey()
  let request: ReturnType<typeof encodeLivePersistentRequest>, started: number, wall: number, mono: number
  try {
    wall = now(); started = mono = monotonic()
    if (!Number.isFinite(started) || started < 0 || opts.retired?.()) throw new Error('live admission unavailable')
    request = encodeLivePersistentRequest({ ...opts, requesterSk: key, now: wall })
  } catch (error) { key.fill(0); return Promise.reject(error) }
  active.add(owner)
  return new Promise((resolve, reject) => {
    let settled = false, publishing = false, checks = 0
    let unsubscribe = () => {}
    const timers: ReturnType<typeof setTimeout>[] = []
    let monitor: ReturnType<typeof setInterval> | undefined
    const finish = (error?: unknown, value?: LivePersistentAnswer): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (monitor !== undefined) clearInterval(monitor)
      opts.signal?.removeEventListener('abort', cancel)
      try { unsubscribe() } catch { /* The closed handler refuses any late event. */ }
      key.fill(0)
      active.delete(owner)
      if (value) resolve(value)
      else reject(error ?? new Error('live admission unavailable'))
    }
    const cancel = (): void => finish(new Error('live admission cancelled'))
    const live = (): boolean => {
      if (settled) return false
      try {
        const at = now(), tick = monotonic()
        if (!Number.isSafeInteger(at) || at < wall || !Number.isFinite(tick) || tick < mono ||
            tick - started >= 90_000 || at >= request.created_at + 90 || opts.retired?.()) {
          finish(new Error('live admission expired, retired or clock moved backwards')); return false
        }
        wall = at; mono = tick
        return true
      } catch (error) { finish(error); return false }
    }
    const offer = (): void => {
      if (!live() || publishing) return
      publishing = true
      try { void opts.transport.publish(copy(request)).catch(() => {}).finally(() => { publishing = false }) }
      catch { publishing = false }
    }
    try {
      opts.signal?.addEventListener('abort', cancel, { once: true })
      if (opts.signal?.aborted) { cancel(); return }
      const invitationId = deriveInvitationId(opts.invitation)
      unsubscribe = opts.transport.subscribe([
        { kinds: [20467], authors: [opts.invitation.inviter], '#d': [invitationId], '#p': [request.pubkey] },
        { kinds: [1461], authors: [opts.invitation.inviter], '#d': [invitationId] },
      ], event => {
        if (!live() || checks >= 64) return
        // The transport must bound raw allocation too; these checks bound this owner's work.
        if (!event || typeof event.content !== 'string' || event.content.length > 16_384 ||
            !Array.isArray(event.tags) || event.tags.length > 8 ||
            !event.tags.every(t => Array.isArray(t) && t.length <= 4 && t.every(v => typeof v === 'string' && v.length <= 256))) return
        checks++
        try {
          if (event.kind === 1461) {
            if (JSON.stringify(event).length > 4096) return
            const notice = decodeInvitationRetirementNotice(event, opts.invitation)
            if (notice) finish(retirementError(notice))
            return
          }
          const bounded = parseLivePersistentEvent(JSON.stringify(event), false)
          if (!bounded) return
          const answer = decodeLivePersistentAnswer(bounded, { ...opts, request, requesterSk: key, now: wall })
          if (answer) finish(undefined, answer)
        } catch { /* Malformed or irrelevant input grants nothing. */ }
      })
      if (settled) { unsubscribe(); return }
      timers.push(setTimeout(() => finish(new Error('live admission timed out')), 90_000))
      timers.push(setTimeout(offer, 30_000), setTimeout(offer, 60_000))
      monitor = setInterval(live, 1000)
      offer()
    } catch (error) { finish(error) }
  })
}
