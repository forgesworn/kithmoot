import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { type RendezvousReceipt, type RendezvousVault, type StoredRendezvousChild } from './rendezvous-vault.js'
import { MlsRoomRefused } from './mls-room-store.js'
import { MAX_OPERATION_SECONDS, type RendezvousEcdhRequest } from './mls-vault.js'

/** Opaque, one-use answer. Shared bytes never leave custody until the
 * matching engine completion inside the final persona transaction. */
export interface MlsEcdhAnswer { readonly type: 'mls-rendezvous-answer' }
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(v)
const key = (r: RendezvousEcdhRequest) => JSON.stringify([r.v, r.operation, r.peer_rz, r.expires_at])
const refuse = (reason: string): never => { throw new MlsRoomRefused(reason) }

export interface MlsRendezvousCustody {
  current(): boolean
  /** Public freshness token only; it confers no scalar/answer authority. */
  releaseCurrent(): boolean
  derive(request: RendezvousEcdhRequest): MlsEcdhAnswer
  accept(request: RendezvousEcdhRequest, answer: MlsEcdhAnswer): Uint8Array
}

/** Lock order is rendezvous then persona, never the reverse. The encrypted
 * source stays locked until work and its cleanup finish. Mutators invalidate
 * before waiting, including in another tab. No identity/device-key fallback. */
export async function withMlsRendezvous<T>(source: RendezvousVault, expected: RendezvousReceipt,
  now: () => number, current: () => boolean, work: (custody: MlsRendezvousCustody) => Promise<T>): Promise<T> {
  expected = Object.freeze({ ...expected })
  if (!hex(expected.identity) || !hex(expected.device) || !hex(expected.rendezvousPubkey) || !Number.isSafeInteger(expected.index) || expected.index < 0 || expected.index > 0xffffffff || !Number.isSafeInteger(expected.expiresAt)) refuse('malformed')
  return source.withCurrentChild(expected.identity, expected.device, async (child, sourceCurrent, sourceReleaseCurrent) => {
    if (!child || !same(child.receipt, expected)) refuse('stale-rendezvous')
    const held = child as StoredRendezvousChild
    let pending: { answer: MlsEcdhAnswer; request: string; deadline: number; shared: Uint8Array } | undefined
    const live = () => current() && sourceCurrent() && Number.isSafeInteger(now()) && now() >= 0 && now() < expected.expiresAt
    const check = () => { if (!live()) refuse('stale-rendezvous') }
    const custody: MlsRendezvousCustody = {
      current: live,
      releaseCurrent: () => current() && sourceReleaseCurrent() && Number.isSafeInteger(now()) && now() >= 0 && now() < expected.expiresAt,
      derive(req) {
        check()
        if (pending) refuse('busy')
        if (!req || Object.keys(req).sort().join(',') !== 'expires_at,operation,peer_rz,v' || req.v !== 1 || !hex(req.operation) || !hex(req.peer_rz) || req.peer_rz === expected.rendezvousPubkey || !Number.isSafeInteger(req.expires_at) || req.expires_at < now() || req.expires_at > now() + MAX_OPERATION_SECONDS) refuse('malformed')
        let shared: Uint8Array
        try {
          shared = held.withScalar(scalar => {
            if (bytesToHex(schnorr.getPublicKey(scalar)) !== expected.rendezvousPubkey) refuse('stale-rendezvous')
            const point = secp256k1.getSharedSecret(scalar, hexToBytes('02' + req.peer_rz))
            try { return point.slice(1) } finally { point.fill(0) }
          })
        } catch (error) { if (error instanceof MlsRoomRefused) throw error; return refuse('malformed') }
        if (!live() || shared.every(b => b === 0)) { shared.fill(0); return refuse('stale-rendezvous') }
        const answer = Object.freeze({ type: 'mls-rendezvous-answer' as const })
        pending = { answer, request: key(req), deadline: req.expires_at, shared }
        return answer
      },
      accept(req, answer) {
        check()
        if (!pending || pending.answer !== answer || pending.request !== key(req)) return refuse('replay')
        if (now() > pending.deadline) return refuse('expired')
        const shared = pending.shared.slice()
        pending.shared.fill(0); pending = undefined
        return shared
      },
    }
    try { check(); return await work(custody) }
    finally { pending?.shared.fill(0); pending = undefined }
  })
}
function same(a: RendezvousReceipt, b: RendezvousReceipt): boolean {
  return a.identity === b.identity && a.device === b.device && a.rendezvousPubkey === b.rendezvousPubkey && a.index === b.index && a.expiresAt === b.expiresAt
}
