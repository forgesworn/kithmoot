import { getPublicKey } from 'nostr-tools/pure'
import { encodeEpochRequest, decodeEpochGrant, EpochRefusedError, type EncodeEpochRequestOptions, type EpochGrant } from './epoch.js'
import type { RelayTransport } from './relay-pool.js'

type Grant = Exclude<EpochGrant, { refused: string }>
export interface FreshEpochOptions extends Omit<EncodeEpochRequestOptions, 'now'> {
  transport: RelayTransport
  floor: () => number
  now: () => number
  timeoutMs: number
  signals?: readonly AbortSignal[]
  sealSks?: () => readonly Uint8Array[]
}

/** Initial admission only: no member source, replay-complete shortcut or route fallback. */
export function requestFreshRootEpoch(opts: FreshEpochOptions): Promise<Grant> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > 90_000) return Promise.reject(new Error('invalid fresh epoch deadline'))
  if (opts.signals?.some(s => s.aborted)) return Promise.reject(new Error('epoch admission cancelled'))
  let wall = opts.now()
  let request: ReturnType<typeof encodeEpochRequest> | undefined
  const device = getPublicKey(opts.deviceSk)
  return new Promise((resolve, reject) => {
    let settled = false, publishing = false, unknown = false, checked = 0
    let unsubscribe = () => {}
    const timers: ReturnType<typeof setTimeout>[] = []
    const finish = (error?: unknown, grant?: Grant): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      for (const signal of opts.signals ?? []) signal.removeEventListener('abort', cancel)
      try { unsubscribe() } catch { /* Late callbacks are fenced by settled. */ }
      if (grant) resolve(grant)
      else reject(error ?? new Error('epoch admission unavailable'))
    }
    const cancel = (): void => finish(new Error('epoch admission cancelled'))
    const live = (): boolean => {
      if (settled) return false
      try {
        const at = opts.now()
        if (!Number.isSafeInteger(at) || at < wall || (opts.expiresAt !== undefined && at >= opts.expiresAt)) {
          finish(new Error('epoch admission expired or clock moved backwards')); return false
        }
        wall = at
        return true
      } catch (error) { finish(error); return false }
    }
    const offer = (): void => {
      if (!live() || publishing) return
      publishing = true
      try {
        // The root desk answers each ID once. A fresh sealed request recovers
        // a lost grant without changing that desk's replay policy.
        request = encodeEpochRequest({ ...opts, now: wall })
        void opts.transport.publish(JSON.parse(JSON.stringify(request))).catch(() => {}).finally(() => { publishing = false })
      }
      catch { publishing = false }
    }
    try {
      for (const signal of opts.signals ?? []) signal.addEventListener('abort', cancel, { once: true })
      if (opts.signals?.some(s => s.aborted)) { cancel(); return }
      unsubscribe = opts.transport.subscribe([{ kinds: [20469], authors: [opts.authority], '#d': [opts.roomId], '#p': [device] }], event => {
        if (!live() || !request || checked >= 64) return
        if (!event || typeof event.content !== 'string' || event.content.length > 262_144 ||
            !Array.isArray(event.tags) || event.tags.length > 8 ||
            !event.tags.every(t => Array.isArray(t) && t.length <= 4 && t.every(v => typeof v === 'string' && v.length <= 256))) return
        checked++
        try {
          if (JSON.stringify(event).length > 263_168) return
          const grant = decodeEpochGrant(event, { roomId: opts.roomId, authority: opts.authority, deviceSk: opts.deviceSk,
            request: request.id, now: wall, sealSks: opts.sealSks?.() })
          if (!grant) return
          if (grant.refused === 'unknown') { unknown = true; return }
          if (grant.refused) { finish(new EpochRefusedError(grant.refused)); return }
          const floor = opts.floor()
          if (!Number.isSafeInteger(floor) || floor < 0 || grant.epoch.epoch < floor) return
          finish(undefined, grant)
        } catch { /* Invalid control input grants nothing. */ }
      })
      if (settled) { unsubscribe(); return }
      timers.push(setTimeout(() => finish(unknown ? new EpochRefusedError('unknown') : new Error('room authority did not confirm admission')), opts.timeoutMs))
      timers.push(setTimeout(offer, opts.timeoutMs / 3), setTimeout(offer, opts.timeoutMs * 2 / 3))
      offer()
    } catch (error) { finish(error) }
  })
}
