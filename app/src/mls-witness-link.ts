import type { LinkRequest, LinkResponse } from './browser-link-types.js'

/** Matches vmls-wasm's witnessAnswer input. The Rust coordinator alone
 * verifies the signature, subject, challenge, sequence and digest. */
export type WitnessAnswer = { type: 'receipt'; bytes: Uint8Array } | { type: 'unavailable' } | { type: 'refused' }
export interface WitnessChannel {
  read(request: Uint8Array): Promise<WitnessAnswer>
  advance(request: Uint8Array): Promise<WitnessAnswer>
}

export function witnessAnswer(response: Pick<LinkResponse, 'status' | 'body' | 'witnessRefused'>): WitnessAnswer {
  // Only the pinned witness's marked refusal can fence an unknown subject.
  // An ordinary router 403 is an availability failure, as on Android.
  if (response.status === 403) return { type: response.witnessRefused ? 'refused' : 'unavailable' }
  const expected = response.status === 200 ? 0 : response.status === 409 ? 1 : response.status === 410 ? 2 : undefined
  if (expected === undefined || response.body.length !== 170 || response.body[0] !== 1 || response.body[1] !== expected) return { type: 'unavailable' }
  return { type: 'receipt', bytes: response.body.slice() }
}

/** One persona's dedicated pinned witness route. No Nostr authentication,
 * HTTP fallback or route selection happens here. A timed-out advance may
 * have committed; the caller must retain its staged candidate and reconcile
 * with the shared coordinator before any network release. */
export class MlsWitnessLink implements WitnessChannel {
  constructor(private readonly transport: { request(request: LinkRequest): Promise<LinkResponse> },
    private readonly routeId: string, private readonly timeoutMs = 20_000) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(routeId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid witness route or timeout.')
  }
  read(request: Uint8Array): Promise<WitnessAnswer> { return this.#exchange('/vmls-witness/v1/read', request) }
  advance(request: Uint8Array): Promise<WitnessAnswer> { return this.#exchange('/vmls-witness/v1/advance', request) }
  async #exchange(path: string, body: Uint8Array): Promise<WitnessAnswer> {
    // vmls-core::witness::MAX_REQUEST_BYTES, before copying or dispatching.
    if (!(body instanceof Uint8Array) || body.length === 0 || body.length > 256) throw new Error('Invalid witness request size.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.transport.request({ routeId: this.routeId, method: 'POST', path, authorization: '', body: body.slice() }).then(witnessAnswer),
        new Promise<WitnessAnswer>(resolve => { timer = setTimeout(() => resolve({ type: 'unavailable' }), this.timeoutMs) }),
      ])
    } catch { return { type: 'unavailable' } }
    finally { clearTimeout(timer) }
  }
}
