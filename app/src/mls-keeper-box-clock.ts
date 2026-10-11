import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import type { BrowserMlsBoxClient } from './mls-box-client.js'
import { mlsGrantReference, validateMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'
import type { MlsRevocationInboxContext } from './mls-revocation-inbox.js'
import type { VaultContext } from './mls-vault.js'

export interface MlsKeeperBoxClockEvidence {
  readonly binding: Readonly<VaultContext>
  readonly node: string
  readonly reference: string
  readonly expiration: number
  readonly boxTime: number
  readonly phoneTime: number
  readonly installation: string
  readonly observedAt: number
}
const label = new TextEncoder().encode('kithmoot/vmls-keeper-clock-probe/v1')
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/** Explicit, development-only clock evidence. The caller owns an independent
 * verified box endpoint, keeps its route installed, and closes it on account
 * or privacy changes. Never call inside a persona/witness transaction or borrow
 * its writer endpoint. This probe cannot prune, revoke or release an MLS hold. */
export class BrowserMlsKeeperBoxClock {
  #epoch = 0
  #clockFloor = 0
  #occupied = false
  #cancel: (() => void) | undefined
  #evidence: { value: MlsKeeperBoxClockEvidence; grant: string; epoch: number } | undefined
  constructor(private client: BrowserMlsBoxClient, private context: () => MlsRevocationInboxContext | undefined,
    private now: () => number = () => Math.floor(Date.now() / 1000), private timeoutMs = 20_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid keeper clock deadline.')
  }
  invalidate(): void { this.#epoch++; this.#evidence = undefined; this.#cancel?.() }

  /** Consume the exact issued observation on witnessed reentry. No I/O here.
   * A refused or aborted witness must obtain a fresh explicit probe. */
  acceptEvidence(grant: MlsGrantRecord, evidence: MlsKeeperBoxClockEvidence): MlsKeeperBoxClockEvidence {
    const retained = this.#evidence; this.#evidence = undefined
    validateMlsGrant(grant)
    const scope = this.context(), at = this.now()
    if (!retained || retained.value !== evidence || retained.epoch !== this.#epoch || retained.grant !== JSON.stringify(grant) || this.#occupied ||
        !scope || !scope.current() || !scope.foreground() || JSON.stringify(scope.vault) !== JSON.stringify(evidence.binding) ||
        !this.client.isCurrent() || !this.client.usesBinding(grant.box.routeId, grant.node, scope.vault)) throw new Error('The keeper clock observation is no longer current. Check the box again.')
    if (!time(at) || at < this.#clockFloor || at < evidence.phoneTime) throw new Error('A trusted keeper time is unavailable.')
    this.#clockFloor = at
    return evidence
  }

  async probe(grant: MlsGrantRecord): Promise<MlsKeeperBoxClockEvidence | null> {
    this.#evidence = undefined
    const expected = structuredClone(grant)
    validateMlsGrant(expected)
    const scope = this.context(), binding = scope && { ...scope.vault }, epoch = this.#epoch, started = this.now()
    if (!scope || !binding || !scope.current() || !scope.foreground() || binding.persona !== expected.issuer ||
        !this.client.isCurrent() || !this.client.usesBinding(expected.box.routeId, expected.node, binding)) throw new Error('Open this exact box in the current keeper account before checking its clock.')
    if (!time(started) || started < this.#clockFloor) throw new Error('A trusted keeper time is unavailable.')
    if (this.#occupied) throw new Error('A keeper clock probe is still settling.')
    this.#clockFloor = started
    let ended = false, floor = started, timer: ReturnType<typeof setTimeout> | undefined, cancel!: () => void
    const deadline = performance.now() + this.timeoutMs
    const current = () => {
      const next = this.context()
      return !ended && performance.now() < deadline && epoch === this.#epoch && scope.current() && scope.foreground() && !!next && next.current() && next.foreground() &&
        JSON.stringify(next.vault) === JSON.stringify(binding) && this.client.isCurrent() && this.client.usesBinding(expected.box.routeId, expected.node, binding)
    }
    const checked = () => {
      if (!current()) throw new Error('The keeper clock context changed.')
      const at = this.now()
      if (!time(at) || at < floor || at < this.#clockFloor) throw new Error('A trusted keeper time is unavailable.')
      floor = at; this.#clockFloor = at
      return at
    }
    const waiting = new Promise<null>(resolve => { cancel = () => { ended = true; resolve(null) } })
    this.#occupied = true; this.#cancel = cancel
    timer = setTimeout(cancel, this.timeoutMs)
    const work = async (): Promise<MlsKeeperBoxClockEvidence | null> => {
      checked()
      const before = await this.client.capabilities(current)
      if (!current()) return null
      checked()
      if (before.state !== 'ok') return null
      const mailbox = sha256(concatBytes(label, hexToBytes(expected.node), hexToBytes(expected.issuer), hexToBytes(expected.device)))
      const fetched = await this.client.fetch([mailbox], undefined, current)
      mailbox.fill(0)
      try {
        if (!current()) return null
        checked()
        if (fetched.state !== 'ok' || !time(fetched.serverTime)) return null
        const after = await this.client.capabilities(current)
        if (!current()) return null
        const phoneTime = checked()
        if (after.state !== 'ok' || after.value.installation !== before.value.installation) return null
        const value: MlsKeeperBoxClockEvidence = Object.freeze({ binding: Object.freeze(binding), node: expected.node, reference: mlsGrantReference(expected.node, expected.grantId), expiration: expected.expiration,
          boxTime: fetched.serverTime, phoneTime, installation: after.value.installation, observedAt: phoneTime })
        this.#evidence = { value, grant: JSON.stringify(expected), epoch }
        return value
      } finally {
        if (fetched.state === 'ok') for (const record of fetched.value.records) { record.mailbox.fill(0); record.receipt.fill(0); record.envelope.fill(0) }
      }
    }
    try { return await Promise.race([work().finally(() => { this.#occupied = false }), waiting]) }
    finally { ended = true; clearTimeout(timer); if (this.#cancel === cancel) this.#cancel = undefined }
  }
}
