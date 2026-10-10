import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import type { BrowserMlsBoxClient } from './mls-box-client.js'
import { mlsGrantReference, validateMlsGrant, type MlsGrantRecord } from './mls-grant-ledger.js'
import type { MlsRevocationInboxContext } from './mls-revocation-inbox.js'
import type { VaultContext } from './mls-vault.js'

export interface MlsKeeperBoxClockEvidence {
  binding: VaultContext
  node: string
  reference: string
  expiration: number
  boxTime: number
  phoneTime: number
  installation: string
  observedAt: number
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
  constructor(private client: BrowserMlsBoxClient, private context: () => MlsRevocationInboxContext | undefined,
    private now: () => number = () => Math.floor(Date.now() / 1000), private timeoutMs = 20_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid keeper clock deadline.')
  }
  invalidate(): void { this.#epoch++; this.#cancel?.() }

  async probe(grant: MlsGrantRecord): Promise<MlsKeeperBoxClockEvidence | null> {
    const expected = structuredClone(grant)
    validateMlsGrant(expected)
    const scope = this.context(), binding = scope && { ...scope.vault }, epoch = this.#epoch, started = this.now()
    if (!scope || !binding || !scope.current() || !scope.foreground() || binding.persona !== expected.issuer ||
        !this.client.isCurrent() || !this.client.usesRoute(expected.box.routeId, expected.node)) throw new Error('Open this exact box in the current keeper account before checking its clock.')
    if (!time(started) || started < this.#clockFloor) throw new Error('A trusted keeper time is unavailable.')
    if (this.#occupied) throw new Error('A keeper clock probe is still settling.')
    this.#clockFloor = started
    let ended = false, floor = started, timer: ReturnType<typeof setTimeout> | undefined, cancel!: () => void
    const current = () => {
      const next = this.context()
      return !ended && epoch === this.#epoch && scope.current() && scope.foreground() && !!next && next.current() && next.foreground() &&
        JSON.stringify(next.vault) === JSON.stringify(binding) && this.client.isCurrent() && this.client.usesRoute(expected.box.routeId, expected.node)
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
        return { binding, node: expected.node, reference: mlsGrantReference(expected.node, expected.grantId), expiration: expected.expiration,
          boxTime: fetched.serverTime, phoneTime, installation: after.value.installation, observedAt: phoneTime }
      } finally {
        if (fetched.state === 'ok') for (const record of fetched.value.records) { record.mailbox.fill(0); record.receipt.fill(0); record.envelope.fill(0) }
      }
    }
    try { return await Promise.race([work().finally(() => { this.#occupied = false }), waiting]) }
    finally { ended = true; clearTimeout(timer); if (this.#cancel === cancel) this.#cancel = undefined }
  }
}
