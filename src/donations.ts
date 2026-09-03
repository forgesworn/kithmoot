import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { verifyEventUncached } from './verify.js'
import { hexEquals, normaliseHex } from './hex.js'
import type { RelayTransport } from './relay-pool.js'

/**
 * What somebody has put into the project, summed from public zap receipts.
 *
 * Nothing here gates anything. The room stays free and equal, and a total
 * of nought is the normal case rather than a failing grade. It is a social
 * cue about who is carrying the running costs, and it is worth exactly what
 * its arithmetic is worth - which is why almost all of this file is about
 * refusing receipts rather than adding them up.
 *
 * THE THING THAT IS EASY TO GET WRONG. "Zap receipts are public, signed
 * events" is true and is not sufficient. A kind 9735 receipt is signed by
 * the RECIPIENT's LNURL provider, not by the donor, so anybody who can
 * write to a relay can publish a receipt naming any donor they like. Three
 * checks make an attribution real, and a total computed without all three
 * is a number anybody can mint:
 *
 *   1. The kind 9734 zap request embedded in the receipt's `description`
 *      tag verifies. That inner event IS signed by the donor, and it is the
 *      only thing that binds a payment to a person.
 *
 *   2. The receipt itself verifies AND was signed by the nostr pubkey that
 *      the project's own LNURL endpoint advertises, read from that endpoint
 *      at runtime. Without this the provider half is unbound and anybody
 *      may mint receipts for the address.
 *
 *   3. The embedded request names the configured recipient in its `p` tag.
 *      Check 2 alone is weaker than it looks against a CUSTODIAL wallet: a
 *      provider serving thousands of customers signs every one of their
 *      receipts with the same key, so a receipt bearing that signature
 *      proves the money reached that provider and not that it reached us.
 *      The recipient named inside the donor's own signature is what says
 *      who was paid.
 *
 * Do any two and not the third and the ring is forgeable. A ring with a
 * number on it is the worst place in an interface to be approximately
 * right about a signature, because it is the one thing worth forging.
 *
 * THE AMOUNT IS THE AMOUNT PAID. It comes from the bolt11 invoice in the
 * receipt, never from the `amount` tag on the request, which states an
 * intention and is not evidence of anything. An invoice that cannot be
 * read contributes nothing rather than a guess.
 *
 * WHAT THIS ASKS RELAYS FOR, because it matters. The subscription filters
 * on the PROJECT's own recipient pubkey and nothing else. Donor pubkeys are
 * never sent anywhere: receipts arrive addressed to the project, and which
 * of them belong to the people in this room is decided in the browser after
 * they arrive. That is deliberate. The profile lookup in the app already
 * hands room relays the participant pubkeys and states its cost in
 * `app/src/profiles.ts`; this feature inherits that cost and does not add
 * to it, which it would the moment a filter carried a donor's key.
 */

/** NIP-57. The receipt, signed by the recipient's LNURL provider. */
export const ZAP_RECEIPT_KIND = 9735
/** NIP-57. The request, signed by the donor, carried inside the receipt. */
export const ZAP_REQUEST_KIND = 9734

const HEX64 = /^[0-9a-f]{64}$/i
/** LUD-16 restricts the local part of a Lightning address to these. */
const ADDRESS_NAME = /^[a-z0-9-_.]+$/i
/** Hostnames only. No port, no path, no userinfo, nothing with a slash in it. */
const ADDRESS_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/**
 * A band on the ring.
 *
 * The bands have no names. A name would be a rank, and the only thing this
 * ring actually knows is a number that the person themselves published by
 * paying an invoice. Change the figures here and every ring in the app
 * changes with them; there is nowhere else a threshold is written down.
 */
export interface DonorTier {
  /** The lowest whole-sat total that reaches this band. */
  readonly from: number
  /** The CSS modifier, `ring-1` lowest. See `app/src/style.css`. */
  readonly ring: string
}

/**
 * Five bands, highest first. The top one is Bitcoin orange and glows; the
 * rest step down in colour and none of them glow. Below the lowest there is
 * NO ring at all rather than a grey one, so that having given nothing is
 * quiet rather than marked.
 */
export const DONOR_TIERS: readonly DonorTier[] = [
  { from: 100_000, ring: 'ring-5' },
  { from: 50_000, ring: 'ring-4' },
  { from: 10_000, ring: 'ring-3' },
  { from: 1_000, ring: 'ring-2' },
  { from: 100, ring: 'ring-1' },
]

/** Which band a total sits in, or undefined for below the lowest. */
export function donorTier(sats: number): DonorTier | undefined {
  if (!Number.isFinite(sats)) return undefined
  return DONOR_TIERS.find((tier) => sats >= tier.from)
}

/**
 * The paid amount from a bolt11 invoice, in millisats.
 *
 * Only the human-readable prefix is read, which is where BOLT11 puts the
 * amount, and only for mainnet: a testnet invoice is not money. There is no
 * checksum check and none is needed - the invoice sits inside an event whose
 * signature is verified before this is called, so an altered invoice is an
 * altered event and has already been thrown away.
 *
 * Returns undefined for an invoice with no amount on it, which is a real and
 * ordinary thing for an invoice to be. That contributes nothing, because the
 * alternative is inventing a figure.
 */
export function bolt11Msats(invoice: unknown): number | undefined {
  if (typeof invoice !== 'string') return undefined
  const text = invoice.trim().toLowerCase()
  // bech32 separates on the LAST '1', and it has to be the last: the amount
  // in the prefix is decimal digits and may well contain a '1' of its own.
  const separator = text.lastIndexOf('1')
  if (separator <= 0) return undefined
  const prefix = text.slice(0, separator)
  const data = text.slice(separator + 1)
  // Signature and checksum alone are 110 characters, so anything shorter is
  // not an invoice whatever else it might be.
  if (data.length < 110 || !/^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(data)) return undefined

  const parsed = /^lnbc(\d+)([munp]?)$/.exec(prefix)
  if (!parsed) return undefined
  const digits = parsed[1]
  // BOLT11: no leading zeroes, and a zero amount is not an amount.
  if (digits.length > 1 && digits.startsWith('0')) return undefined
  const amount = BigInt(digits)
  if (amount === 0n) return undefined

  // One bitcoin is 10^11 millisats, and the multiplier scales the prefix
  // figure by a fraction of a bitcoin.
  let msats: bigint
  switch (parsed[2]) {
    case 'm':
      msats = amount * 100_000_000n
      break
    case 'u':
      msats = amount * 100_000n
      break
    case 'n':
      msats = amount * 100n
      break
    case 'p':
      // BOLT11 requires a pico amount to be a multiple of ten, because a
      // tenth of a millisat cannot be paid.
      if (amount % 10n !== 0n) return undefined
      msats = amount / 10n
      break
    default:
      msats = amount * 100_000_000_000n
  }
  const value = Number(msats)
  return Number.isSafeInteger(value) ? value : undefined
}

/** The `https://` URL a Lightning address resolves to, per LUD-16. */
export function lnurlpUrl(address: string): string | undefined {
  const trimmed = address.trim()
  const at = trimmed.indexOf('@')
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return undefined
  const name = trimmed.slice(0, at)
  const host = trimmed.slice(at + 1).toLowerCase()
  if (!ADDRESS_NAME.test(name) || !ADDRESS_HOST.test(host)) return undefined
  return `https://${host}/.well-known/lnurlp/${encodeURIComponent(name)}`
}

/** What the project's own address says about who signs its receipts. */
export interface ZapEndpoint {
  /** The pubkey the endpoint advertises as the signer of its receipts. */
  readonly nostrPubkey: string
}

export interface FetchZapEndpointOptions {
  fetch: typeof globalThis.fetch
  /** Give up rather than leave a lookup open for the life of the page. */
  timeoutMs?: number
}

const ENDPOINT_TIMEOUT_MS = 5_000

/**
 * Ask a Lightning address which pubkey signs its zap receipts.
 *
 * Read at runtime and never written down in the source. A wallet that
 * changes provider, or drops zap support altogether, then stops producing
 * an answer here and the feature goes dark, which is the correct outcome:
 * a hardcoded provider key would keep on accepting receipts signed by
 * somebody who is no longer paid by this address.
 *
 * Returns undefined for anything short of a clear answer, including an
 * endpoint that does not advertise a key at all. Never throws.
 */
export async function fetchZapEndpoint(address: string, opts: FetchZapEndpointOptions): Promise<ZapEndpoint | undefined> {
  const url = lnurlpUrl(address)
  if (url === undefined) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? ENDPOINT_TIMEOUT_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  try {
    const response = await opts.fetch(url, { signal: controller.signal })
    if (!response.ok) return undefined
    const body = (await response.json()) as Record<string, unknown>
    // Both halves are required. `allowsNostr` without a key says nothing,
    // and a key on an endpoint that does not claim to zap is not one we
    // should be trusting receipts to.
    if (body.allowsNostr !== true) return undefined
    const nostrPubkey = body.nostrPubkey
    if (typeof nostrPubkey !== 'string' || !HEX64.test(nostrPubkey)) return undefined
    return { nostrPubkey: normaliseHex(nostrPubkey) }
  } catch {
    // A refusal, a timeout, or somebody else's JSON. All of them are "no".
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export interface CreditOptions {
  /** The pubkey the configured address's own endpoint advertises. */
  readonly providerPubkey: string
  /** The pubkey a donation has to be addressed to, to be ours. */
  readonly recipient: string
}

/** One donation, once all three checks have passed. */
export interface ZapCredit {
  /** The donor, taken from the signature on the embedded request and from
   *  nowhere else. */
  readonly donor: string
  /** What the invoice says was payable, in millisats. */
  readonly msats: number
}

function tagValue(event: Pick<Event, 'tags'>, name: string): string | undefined {
  const tag = event.tags.find((t) => t[0] === name)
  return typeof tag?.[1] === 'string' ? tag[1] : undefined
}

/**
 * Read one zap receipt, or refuse it.
 *
 * THIS IS WHERE THE THREE CHECKS LIVE, and it is the only door into a
 * total: `tallyDonations` and `DonationLedger` both go through here, so a
 * receipt cannot reach a ring by any other route. Refusal is silent and
 * total. There is no partial credit and no benefit of the doubt.
 */
export function creditFromReceipt(receipt: Event, opts: CreditOptions): ZapCredit | undefined {
  if (!HEX64.test(opts.providerPubkey) || !HEX64.test(opts.recipient)) return undefined
  if (receipt.kind !== ZAP_RECEIPT_KIND) return undefined

  // CHECK TWO, first half: the right signer. Cheap, so it goes before the
  // arithmetic of verifying anything.
  if (!hexEquals(receipt.pubkey, opts.providerPubkey)) return undefined
  // The receipt should also be addressed to us on its face. This is not the
  // check that matters - the outer event is not signed by the donor - but a
  // receipt that names somebody else is not ours whatever it carries.
  const receiptRecipient = tagValue(receipt, 'p')
  if (receiptRecipient === undefined || !hexEquals(receiptRecipient, opts.recipient)) return undefined
  // CHECK TWO, second half: that signature is real. This also re-derives
  // the event id, so it is what binds the `description` tag below to the
  // provider rather than to whoever handed us this object.
  if (!verifyEventUncached(receipt)) return undefined

  const description = tagValue(receipt, 'description')
  if (description === undefined) return undefined
  let request: Event
  try {
    request = JSON.parse(description) as Event
  } catch {
    return undefined
  }
  if (request === null || typeof request !== 'object' || request.kind !== ZAP_REQUEST_KIND) return undefined

  // CHECK ONE: the donor's own signature. Everything above proves a
  // provider said something. This is the only thing that says a person did.
  if (!verifyEventUncached(request)) return undefined

  // CHECK THREE: the donor said who they were paying. Against a custodial
  // wallet, whose provider key is shared with every other customer, this is
  // the check that separates a donation to this project from a donation to
  // a stranger who banks in the same place.
  const paid = tagValue(request, 'p')
  if (paid === undefined || !hexEquals(paid, opts.recipient)) return undefined

  // The amount actually payable, never the `amount` tag on the request.
  const msats = bolt11Msats(tagValue(receipt, 'bolt11'))
  if (msats === undefined) return undefined

  return { donor: normaliseHex(request.pubkey), msats }
}

export interface TallyOptions extends CreditOptions {
  /** Only these are reported on. Everybody else's receipts are read and
   *  discarded, which is what keeps donor keys out of the relay filter. */
  readonly pubkeys: Iterable<string>
}

/**
 * Sum verified receipts per donor, in millisats.
 *
 * Every named pubkey appears in the result, at nought if nothing of theirs
 * survived the checks, so a caller can tell "asked and there is nothing"
 * from "not asked yet". Duplicate deliveries of one receipt count once:
 * relays repeat themselves, and a total that grew every time a socket
 * reconnected would be nonsense.
 */
export function tallyDonations(receipts: Iterable<Event>, opts: TallyOptions): Map<string, number> {
  const totals = new Map<string, number>()
  for (const pubkey of opts.pubkeys) totals.set(normaliseHex(pubkey), 0)
  const counted = new Set<string>()
  for (const receipt of receipts) {
    if (counted.has(receipt.id)) continue
    const credit = creditFromReceipt(receipt, opts)
    if (credit === undefined) continue
    counted.add(receipt.id)
    const running = totals.get(credit.donor)
    if (running === undefined) continue
    totals.set(credit.donor, running + credit.msats)
  }
  return totals
}

/** Millisats to the whole sats a ring is banded on. */
export function satsOf(msats: number): number {
  return Math.floor(msats / 1000)
}

export interface RingInput {
  /** True only for a key with a published Nostr profile. A per-device key
   *  has no identity a donation could be attributed to and no picture to
   *  draw a ring around, so it never gets one. */
  readonly nostr: boolean
  /** The verified total in whole sats, or undefined while it is unknown. */
  readonly sats?: number
}

/**
 * Whether to draw a ring, and which.
 *
 * The single place the answer is decided, so a tile, a chip and a chat line
 * cannot disagree. Undefined means draw nothing at all: no ring, no
 * placeholder, no empty circle. Somebody who joined by typing a name looks
 * exactly as they did before this feature existed, and so does somebody
 * whose total has not come back yet.
 */
export function ringTier(input: RingInput): DonorTier | undefined {
  if (!input.nostr || input.sats === undefined) return undefined
  return donorTier(input.sats)
}

export interface DonationLedgerOptions {
  /** The project's Lightning address. Empty means the whole feature is off:
   *  no lookups, no sockets, no rings, nothing on the console. */
  address: string
  /** The pubkey donations must be addressed to. Empty means the same. */
  recipient: string
  /** Read lazily, so nothing is chosen before a room is known. */
  relays: () => string[]
  /** Built on first use, and only if there is anything to do. Tests hand in
   *  the in-process simulator and touch no network. */
  transport: (relays: string[]) => RelayTransport
  fetch: typeof globalThis.fetch
  /** Called when a total changed and something should be redrawn. */
  onChange: () => void
  /** How long a total stands before it is looked up again. */
  ttlMs?: number
  /** How long one sweep listens before it settles for what it has. */
  windowMs?: number
  now?: () => number
}

/** Long enough that a roster change never re-queries, short enough that a
 *  donation made during a meeting shows up in the same meeting. */
const DEFAULT_TTL_MS = 10 * 60 * 1000
/** A sweep is a subscription to stored events: relays answer at once or not
 *  at all, so this is a settling time, not a budget. */
const DEFAULT_WINDOW_MS = 6_000
/** A hostile relay must not be able to grow this page's memory without
 *  bound by replaying receipts at it. */
const MAX_RECEIPTS_PER_SWEEP = 5_000

/**
 * Totals for the people in a room, kept fresh in the background.
 *
 * Never blocks a render. `sats()` answers immediately with whatever is
 * known, which at first is nothing: the person is drawn, and the ring
 * arrives afterwards through `onChange` if there is one to draw.
 */
export class DonationLedger {
  readonly #opts: DonationLedgerOptions
  readonly #ttlMs: number
  readonly #windowMs: number
  readonly #now: () => number
  /** Verified totals in millisats, by donor. */
  readonly #msats = new Map<string, number>()
  /** When each pubkey's total stops being fresh. */
  readonly #settled = new Map<string, number>()
  /** Asked about, and waiting on the next sweep to settle. */
  readonly #wanted = new Set<string>()
  #endpoint?: ZapEndpoint
  #transport?: RelayTransport
  #sweeping = false
  #closed = false

  constructor(opts: DonationLedgerOptions) {
    this.#opts = opts
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.#windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.#now = opts.now ?? (() => Date.now())
  }

  /**
   * Whether there is anything to do at all.
   *
   * Both settings have to be present and well formed. An operator who sets
   * neither gets an app that behaves exactly as it did before this existed,
   * and one who sets only the address gets the same, because a total that
   * is not bound to a recipient is not a total of anything.
   */
  get enabled(): boolean {
    return lnurlpUrl(this.#opts.address) !== undefined && HEX64.test(this.#opts.recipient.trim())
  }

  /** The address a total is computed against, for saying so in the tooltip. */
  get address(): string {
    return this.#opts.address.trim()
  }

  /** The pubkey a total is computed against, likewise. */
  get recipient(): string {
    return normaliseHex(this.#opts.recipient.trim())
  }

  /**
   * Ask about these people. Cheap to call on every render: it does nothing
   * for a pubkey whose total is still fresh, and nothing at all when the
   * feature is off.
   */
  want(pubkeys: readonly string[]): void {
    if (this.#closed || !this.enabled) return
    const now = this.#now()
    let added = false
    for (const raw of pubkeys) {
      const pubkey = normaliseHex(raw)
      if (!HEX64.test(pubkey)) continue
      if ((this.#settled.get(pubkey) ?? 0) > now) continue
      if (this.#wanted.has(pubkey)) continue
      this.#wanted.add(pubkey)
      added = true
    }
    if (added) void this.#sweep()
  }

  /**
   * The verified total for one person, in whole sats, or undefined while
   * nothing is known yet. Nought is an answer; undefined is not one.
   */
  sats(pubkey: string): number | undefined {
    const key = normaliseHex(pubkey)
    const msats = this.#msats.get(key)
    if (msats !== undefined) return satsOf(msats)
    return this.#settled.has(key) ? 0 : undefined
  }

  close(): void {
    this.#closed = true
    this.#transport?.close()
    this.#transport = undefined
  }

  /** One pass: resolve the endpoint if it is not known, read receipts for a
   *  settling window, then stamp everybody asked about as fresh. */
  async #sweep(): Promise<void> {
    if (this.#sweeping || this.#closed) return
    this.#sweeping = true
    try {
      this.#endpoint ??= await fetchZapEndpoint(this.#opts.address, { fetch: this.#opts.fetch })
      if (this.#closed) return
      // An address that does not advertise a signer cannot have its
      // receipts checked, so it gets none. Stamped anyway, so a render loop
      // asks once per lifetime rather than once per frame.
      if (this.#endpoint !== undefined) await this.#read(this.#endpoint)
      this.#settle()
    } catch {
      // A ring is decoration. Nothing here is allowed to break a room.
      this.#settle()
    } finally {
      this.#sweeping = false
      // Somebody new may have been asked about while this was running.
      if (!this.#closed && this.#wanted.size > 0) void this.#sweep()
    }
  }

  async #read(endpoint: ZapEndpoint): Promise<void> {
    const relays = this.#opts.relays()
    if (relays.length === 0) return
    this.#transport ??= this.#opts.transport(relays)
    const transport = this.#transport
    const seen = new Set<string>()
    let changed = false
    // The ONLY thing this asks a relay for: receipts addressed to the
    // project. No donor key is ever in this filter. See the note at the top
    // of this file for why that is load-bearing rather than tidy.
    const filter: Filter = { kinds: [ZAP_RECEIPT_KIND], '#p': [this.recipient] }
    await new Promise<void>((resolve) => {
      const unsub = transport.subscribe([filter], (receipt) => {
        if (seen.size >= MAX_RECEIPTS_PER_SWEEP || seen.has(receipt.id)) return
        seen.add(receipt.id)
        const credit = creditFromReceipt(receipt, { providerPubkey: endpoint.nostrPubkey, recipient: this.recipient })
        if (credit === undefined) return
        this.#msats.set(credit.donor, (this.#msats.get(credit.donor) ?? 0) + credit.msats)
        changed = true
      })
      const timer = setTimeout(() => {
        unsub()
        resolve()
      }, this.#windowMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    // One redraw for the sweep rather than one per receipt: a busy address
    // would otherwise re-render the room hundreds of times.
    if (changed && !this.#closed) this.#opts.onChange()
  }

  #settle(): void {
    const until = this.#now() + this.#ttlMs
    let settled = false
    for (const pubkey of this.#wanted) {
      this.#settled.set(pubkey, until)
      settled = true
    }
    this.#wanted.clear()
    // Somebody may have gone from "unknown" to "nought", which is the
    // difference between a ring that might appear and one that will not.
    if (settled && !this.#closed) this.#opts.onChange()
  }
}
