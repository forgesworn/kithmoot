import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import {
  DONOR_TIERS,
  DonationLedger,
  bolt11Msats,
  creditFromReceipt,
  donorTier,
  fetchZapEndpoint,
  lnurlpUrl,
  ringTier,
  satsOf,
  tallyDonations,
} from './donations.js'
import type { RelayTransport } from './relay-pool.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const NOW = 1_800_000_000

/** The BOLT11 specification's own 2500u test vector: 250,000 sats. */
const SPEC_INVOICE =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'

/** bech32's data alphabet, which deliberately contains no `1`. */
const DATA = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(4)

/** A well-formed invoice with the given prefix. The reader never checks a
 *  checksum, and does not need to: an invoice sits inside an event whose
 *  signature is checked before the invoice is read. */
function invoiceWith(prefix: string): string {
  return `${prefix}1${DATA}`
}

const providerSk = generateSecretKey()
const provider = getPublicKey(providerSk)
const donorSk = generateSecretKey()
const donor = getPublicKey(donorSk)
const otherDonorSk = generateSecretKey()
const otherDonor = getPublicKey(otherDonorSk)
const recipient = getPublicKey(generateSecretKey())
const stranger = getPublicKey(generateSecretKey())

function zapRequest(sk: Uint8Array, opts: { to?: string; amount?: string; kind?: number } = {}): Event {
  const tags: string[][] = [['p', opts.to ?? recipient], ['relays', 'wss://relay.example']]
  if (opts.amount !== undefined) tags.push(['amount', opts.amount])
  const template: EventTemplate = { kind: opts.kind ?? 9734, created_at: NOW, content: '', tags }
  return finalizeEvent(template, sk)
}

function zapReceipt(opts: { request: unknown; sk?: Uint8Array; to?: string; bolt11?: string }): Event {
  const template: EventTemplate = {
    kind: 9735,
    created_at: NOW + 1,
    content: '',
    tags: [
      ['p', opts.to ?? recipient],
      ['bolt11', opts.bolt11 ?? SPEC_INVOICE],
      ['description', JSON.stringify(opts.request)],
    ],
  }
  return finalizeEvent(template, opts.sk ?? providerSk)
}

const credits = { providerPubkey: provider, recipient }

describe('reading an amount off a bolt11 invoice', () => {
  it('reads the specification vector, and every multiplier', () => {
    expect(bolt11Msats(SPEC_INVOICE)).toBe(250_000_000)
    expect(satsOf(bolt11Msats(SPEC_INVOICE) as number)).toBe(250_000)
    expect(bolt11Msats(invoiceWith('lnbc1m'))).toBe(100_000_000)
    expect(bolt11Msats(invoiceWith('lnbc1u'))).toBe(100_000)
    expect(bolt11Msats(invoiceWith('lnbc1n'))).toBe(100)
    expect(bolt11Msats(invoiceWith('lnbc10p'))).toBe(1)
    // No multiplier at all is whole bitcoin.
    expect(bolt11Msats(invoiceWith('lnbc1'))).toBe(100_000_000_000)
    // The amount may itself contain the character bech32 separates on, which
    // is why the separator is the last one and not the first.
    expect(bolt11Msats(invoiceWith('lnbc1500u'))).toBe(150_000_000)
  })

  it('contributes nothing rather than a guess', () => {
    // An invoice with no amount on it is an ordinary thing for an invoice
    // to be, and there is no figure in it to credit anybody with.
    expect(bolt11Msats(invoiceWith('lnbc'))).toBeUndefined()
    expect(bolt11Msats(invoiceWith('lnbc0'))).toBeUndefined()
    // BOLT11 forbids a leading zero, and a reader that accepts one is
    // reading a different invoice from the one that was paid.
    expect(bolt11Msats(invoiceWith('lnbc0500u'))).toBeUndefined()
    // A pico amount has to be a multiple of ten: a tenth of a millisat
    // cannot be paid.
    expect(bolt11Msats(invoiceWith('lnbc11p'))).toBeUndefined()
    // Testnet is not money.
    expect(bolt11Msats(invoiceWith('lntb2500u'))).toBeUndefined()
    expect(bolt11Msats(invoiceWith('lnbcrt2500u'))).toBeUndefined()
    expect(bolt11Msats('lnbc2500u1short')).toBeUndefined()
    expect(bolt11Msats(`lnbc2500u1${'b'.repeat(120)}`)).toBeUndefined()
    expect(bolt11Msats('not an invoice')).toBeUndefined()
    expect(bolt11Msats('')).toBeUndefined()
    expect(bolt11Msats(undefined)).toBeUndefined()
    expect(bolt11Msats(42)).toBeUndefined()
  })
})

describe('resolving a Lightning address', () => {
  it('builds the well-known URL, and refuses anything that is not an address', () => {
    expect(lnurlpUrl('kithmoot@example.com')).toBe('https://example.com/.well-known/lnurlp/kithmoot')
    expect(lnurlpUrl('  Kithmoot@Example.COM  ')).toBe('https://example.com/.well-known/lnurlp/Kithmoot')
    expect(lnurlpUrl('')).toBeUndefined()
    expect(lnurlpUrl('kithmoot')).toBeUndefined()
    expect(lnurlpUrl('@example.com')).toBeUndefined()
    expect(lnurlpUrl('kithmoot@')).toBeUndefined()
    expect(lnurlpUrl('a@b@example.com')).toBeUndefined()
    expect(lnurlpUrl('kithmoot@localhost')).toBeUndefined()
    expect(lnurlpUrl('kithmoot@example.com/../evil')).toBeUndefined()
    expect(lnurlpUrl('kith moot@example.com')).toBeUndefined()
  })

  it('takes the provider key from the endpoint, and refuses an endpoint that advertises none', async () => {
    const asked: string[] = []
    const answering = (body: unknown, ok = true): typeof globalThis.fetch =>
      (async (url: string | URL) => {
        asked.push(String(url))
        return { ok, json: async () => body } as Response
      }) as unknown as typeof globalThis.fetch

    await expect(fetchZapEndpoint('kithmoot@example.com', { fetch: answering({ allowsNostr: true, nostrPubkey: provider.toUpperCase() }) })).resolves.toEqual({
      nostrPubkey: provider,
    })
    expect(asked).toEqual(['https://example.com/.well-known/lnurlp/kithmoot'])

    // A wallet that stops supporting zaps, or changes provider and no longer
    // says who signs for it, must take the feature dark rather than leave it
    // accepting whatever turns up.
    const opts = { fetch: answering({ allowsNostr: false, nostrPubkey: provider }) }
    await expect(fetchZapEndpoint('kithmoot@example.com', opts)).resolves.toBeUndefined()
    await expect(fetchZapEndpoint('kithmoot@example.com', { fetch: answering({ allowsNostr: true }) })).resolves.toBeUndefined()
    await expect(fetchZapEndpoint('kithmoot@example.com', { fetch: answering({ allowsNostr: true, nostrPubkey: 'not hex' }) })).resolves.toBeUndefined()
    await expect(fetchZapEndpoint('kithmoot@example.com', { fetch: answering({ allowsNostr: true, nostrPubkey: provider }, false) })).resolves.toBeUndefined()

    // A refusal, a timeout or somebody else's JSON are all just "no".
    const throwing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof globalThis.fetch
    await expect(fetchZapEndpoint('kithmoot@example.com', { fetch: throwing })).resolves.toBeUndefined()

    // Nothing is asked of the network for something that is not an address.
    const before = asked.length
    await expect(fetchZapEndpoint('not-an-address', { fetch: answering({ allowsNostr: true, nostrPubkey: provider }) })).resolves.toBeUndefined()
    expect(asked.length).toBe(before)
  })
})

describe('the three checks on a zap receipt', () => {
  it('credits the donor who signed the request, for what the invoice says', () => {
    const receipt = zapReceipt({ request: zapRequest(donorSk) })
    expect(creditFromReceipt(receipt, credits)).toEqual({ donor, msats: 250_000_000 })
  })

  it('refuses a forged receipt: anybody may publish one naming any donor', () => {
    // The whole attack in one test. A stranger writes a receipt to a relay
    // saying this donor paid, and signs it with their own key because they
    // do not have the provider's. Nothing about it is malformed.
    const forgerSk = generateSecretKey()
    const forged = zapReceipt({ request: zapRequest(donorSk), sk: forgerSk })
    expect(forged.kind).toBe(9735)
    expect(creditFromReceipt(forged, credits)).toBeUndefined()

    // And the same receipt read against the forger's own key as provider is
    // accepted, which is the point: the check is on WHICH key signed, so it
    // is worth exactly as much as knowing the right key to expect.
    expect(creditFromReceipt(forged, { providerPubkey: getPublicKey(forgerSk), recipient })).toEqual({ donor, msats: 250_000_000 })
  })

  it('refuses a valid outer signature over a tampered inner request', () => {
    // The subtler attack, and the reason check one exists. The receipt is
    // signed by the real provider key and verifies perfectly. What was
    // swapped is the request inside it, so that a genuine payment is
    // credited to somebody who never made one.
    const real = zapRequest(donorSk)
    const relabelled = { ...real, pubkey: otherDonor }
    expect(creditFromReceipt(zapReceipt({ request: relabelled }), credits)).toBeUndefined()

    // The same again with the signature broken rather than the author
    // changed, and with the id left stale after an edit.
    expect(creditFromReceipt(zapReceipt({ request: { ...real, sig: 'ff'.repeat(64) } }), credits)).toBeUndefined()
    expect(creditFromReceipt(zapReceipt({ request: { ...real, content: 'thanks' } }), credits)).toBeUndefined()
    expect(creditFromReceipt(zapReceipt({ request: { ...real, id: 'ab'.repeat(32) } }), credits)).toBeUndefined()

    // A receipt whose own signature was broken after it was written, rather
    // than the request inside it.
    const receipt = zapReceipt({ request: real })
    expect(creditFromReceipt({ ...receipt, sig: 'ff'.repeat(64) }, credits)).toBeUndefined()
    expect(creditFromReceipt({ ...receipt, tags: [...receipt.tags, ['extra', 'x']] }, credits)).toBeUndefined()
  })

  it('refuses a receipt from the wrong provider key', () => {
    const elsewhereSk = generateSecretKey()
    const receipt = zapReceipt({ request: zapRequest(donorSk), sk: elsewhereSk })
    expect(creditFromReceipt(receipt, credits)).toBeUndefined()
    // Case on the way in does not change which key it names.
    expect(creditFromReceipt(zapReceipt({ request: zapRequest(donorSk) }), { providerPubkey: provider.toUpperCase(), recipient })).toMatchObject({ donor })
  })

  it('refuses a receipt addressed to somebody else, however well signed', () => {
    // This is the one a shared custodial provider makes real. The provider
    // key is the same key for every customer of that wallet, so a donation
    // one stranger makes to another carries a signature that passes check
    // two exactly as ours does. Only the recipient named inside the donor's
    // own signature tells the two apart.
    const neighbour = zapReceipt({ request: zapRequest(donorSk, { to: stranger }), to: stranger })
    expect(creditFromReceipt(neighbour, credits)).toBeUndefined()

    // And the half-and-half version: the receipt says it is ours on its
    // face, but the request the donor actually signed names somebody else.
    const mismatched = zapReceipt({ request: zapRequest(donorSk, { to: stranger }) })
    expect(creditFromReceipt(mismatched, credits)).toBeUndefined()
  })

  it('refuses a receipt whose invoice cannot be read, rather than guessing', () => {
    // An intention is not a payment. The `amount` tag on the request says
    // what the donor meant to send and is never read.
    const request = zapRequest(donorSk, { amount: '999000000' })
    expect(creditFromReceipt(zapReceipt({ request }), credits)).toEqual({ donor, msats: 250_000_000 })
    expect(creditFromReceipt(zapReceipt({ request, bolt11: invoiceWith('lnbc') }), credits)).toBeUndefined()
    expect(creditFromReceipt(zapReceipt({ request, bolt11: 'nonsense' }), credits)).toBeUndefined()

    const noInvoice = finalizeEvent(
      { kind: 9735, created_at: NOW, content: '', tags: [['p', recipient], ['description', JSON.stringify(request)]] },
      providerSk,
    )
    expect(creditFromReceipt(noInvoice, credits)).toBeUndefined()
  })

  it('refuses anything that is not a receipt carrying a request', () => {
    const request = zapRequest(donorSk)
    expect(creditFromReceipt({ ...zapReceipt({ request }), kind: 1 }, credits)).toBeUndefined()
    expect(creditFromReceipt(zapReceipt({ request: 'not json at all' }), credits)).toBeUndefined()
    expect(creditFromReceipt(zapReceipt({ request: null }), credits)).toBeUndefined()
    expect(creditFromReceipt(zapReceipt({ request: zapRequest(donorSk, { kind: 1 }) }), credits)).toBeUndefined()
    const noDescription = finalizeEvent(
      { kind: 9735, created_at: NOW, content: '', tags: [['p', recipient], ['bolt11', SPEC_INVOICE]] },
      providerSk,
    )
    expect(creditFromReceipt(noDescription, credits)).toBeUndefined()
    // No configuration, no credit.
    expect(creditFromReceipt(zapReceipt({ request }), { providerPubkey: '', recipient })).toBeUndefined()
    expect(creditFromReceipt(zapReceipt({ request }), { providerPubkey: provider, recipient: '' })).toBeUndefined()
  })
})

describe('summing what survived', () => {
  it('sums per donor, counts a repeated receipt once, and names everybody asked about', () => {
    const first = zapReceipt({ request: zapRequest(donorSk), bolt11: invoiceWith('lnbc1u') })
    const second = zapReceipt({ request: zapRequest(donorSk), bolt11: invoiceWith('lnbc2u') })
    const theirs = zapReceipt({ request: zapRequest(otherDonorSk), bolt11: invoiceWith('lnbc5u') })
    const forged = zapReceipt({ request: zapRequest(donorSk), sk: generateSecretKey(), bolt11: invoiceWith('lnbc9m') })

    // `first` twice: relays repeat themselves, and a total that grew on a
    // reconnect would be nonsense.
    const totals = tallyDonations([first, second, first, theirs, forged], { ...credits, pubkeys: [donor, otherDonor, stranger] })
    expect(totals.get(donor)).toBe(300_000)
    expect(totals.get(otherDonor)).toBe(500_000)
    // Asked about, nothing found: nought, which is an answer.
    expect(totals.get(stranger)).toBe(0)
    expect(totals.size).toBe(3)
  })

  it('reports on nobody it was not asked about', () => {
    const receipt = zapReceipt({ request: zapRequest(donorSk) })
    const totals = tallyDonations([receipt], { ...credits, pubkeys: [otherDonor] })
    expect(totals.has(donor)).toBe(false)
    expect(totals.get(otherDonor)).toBe(0)
  })
})

describe('the tier scale', () => {
  it('is five bands, topped at a hundred thousand sats', () => {
    expect(DONOR_TIERS.length).toBe(5)
    expect(DONOR_TIERS[0]).toEqual({ from: 100_000, ring: 'ring-5' })
    // Highest first, and strictly descending, or `donorTier` picks wrong.
    for (let i = 1; i < DONOR_TIERS.length; i++) expect(DONOR_TIERS[i].from).toBeLessThan(DONOR_TIERS[i - 1].from)
  })

  it('bands on the boundary, and draws nothing below the lowest', () => {
    expect(donorTier(100_000)?.ring).toBe('ring-5')
    expect(donorTier(99_999)?.ring).toBe('ring-4')
    expect(donorTier(1_000_000)?.ring).toBe('ring-5')
    expect(donorTier(50_000)?.ring).toBe('ring-4')
    expect(donorTier(49_999)?.ring).toBe('ring-3')
    expect(donorTier(10_000)?.ring).toBe('ring-3')
    expect(donorTier(9_999)?.ring).toBe('ring-2')
    expect(donorTier(1_000)?.ring).toBe('ring-2')
    expect(donorTier(999)?.ring).toBe('ring-1')
    expect(donorTier(100)?.ring).toBe('ring-1')
    // Below the lowest band there is no ring at all, not a grey one.
    expect(donorTier(99)).toBeUndefined()
    expect(donorTier(0)).toBeUndefined()
    expect(donorTier(Number.NaN)).toBeUndefined()
  })

  it('rings nobody who joined with a per-device key, whatever the figure', () => {
    // A typed name has no identity to attribute a payment to. There is no
    // ring and no placeholder: they look exactly as they did before.
    expect(ringTier({ nostr: false, sats: 1_000_000 })).toBeUndefined()
    expect(ringTier({ nostr: false })).toBeUndefined()
    // Nor is anything drawn while the answer is still on its way.
    expect(ringTier({ nostr: true })).toBeUndefined()
    expect(ringTier({ nostr: true, sats: 0 })).toBeUndefined()
    expect(ringTier({ nostr: true, sats: 100_000 })?.ring).toBe('ring-5')
  })
})

/** Records what was asked of a relay, and how often a socket was built. */
class SpyTransport implements RelayTransport {
  static built = 0
  static filters: Filter[] = []
  readonly #inner: SimTransport

  constructor(relay: SimRelay) {
    SpyTransport.built++
    this.#inner = new SimTransport(relay)
  }

  publish(event: Event): Promise<void> {
    return this.#inner.publish(event)
  }

  subscribe(filters: Filter[], onEvent: (event: Event) => void): () => void {
    SpyTransport.filters.push(...filters)
    return this.#inner.subscribe(filters, onEvent)
  }

  close(): void {
    this.#inner.close()
  }
}

/** Lets a sweep's settling window elapse. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function ledgerFixture(overrides: { address?: string; recipient?: string; body?: unknown } = {}) {
  SpyTransport.built = 0
  SpyTransport.filters = []
  const relay = new SimRelay({ replay: true })
  let fetches = 0
  let changes = 0
  let clock = NOW * 1000
  const ledger = new DonationLedger({
    address: overrides.address ?? 'kithmoot@example.com',
    recipient: overrides.recipient ?? recipient,
    relays: () => ['wss://relay.example'],
    transport: () => new SpyTransport(relay),
    fetch: (async () => {
      fetches++
      return { ok: true, json: async () => overrides.body ?? { allowsNostr: true, nostrPubkey: provider } } as Response
    }) as unknown as typeof globalThis.fetch,
    onChange: () => {
      changes++
    },
    windowMs: 0,
    ttlMs: 60_000,
    now: () => clock,
  })
  return {
    ledger,
    relay,
    fetches: () => fetches,
    changes: () => changes,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('the ledger', () => {
  it('does no work at all with nothing configured', async () => {
    for (const off of [{ address: '' }, { recipient: '' }, { address: 'not-an-address' }, { recipient: 'not hex' }]) {
      const fixture = ledgerFixture(off)
      expect(fixture.ledger.enabled).toBe(false)
      fixture.ledger.want([donor, otherDonor])
      await settle()
      // No endpoint lookup, no socket, no filter, no redraw, no ring.
      expect(fixture.fetches()).toBe(0)
      expect(SpyTransport.built).toBe(0)
      expect(SpyTransport.filters).toEqual([])
      expect(fixture.changes()).toBe(0)
      expect(fixture.ledger.sats(donor)).toBeUndefined()
    }
  })

  it('rings a donor once the answer arrives, and never blocks on it', async () => {
    const fixture = ledgerFixture()
    fixture.relay.publish(zapReceipt({ request: zapRequest(donorSk), bolt11: invoiceWith('lnbc1500u') }))
    fixture.relay.publish(zapReceipt({ request: zapRequest(otherDonorSk), bolt11: invoiceWith('lnbc2u') }))
    fixture.relay.publish(zapReceipt({ request: zapRequest(donorSk), sk: generateSecretKey(), bolt11: invoiceWith('lnbc9m') }))

    expect(fixture.ledger.enabled).toBe(true)
    fixture.ledger.want([donor, otherDonor, stranger])
    // Nothing is known yet, and the caller was not made to wait for it.
    expect(fixture.ledger.sats(donor)).toBeUndefined()

    await settle()
    expect(fixture.ledger.sats(donor)).toBe(150_000)
    expect(fixture.ledger.sats(otherDonor)).toBe(200)
    // Asked about and nothing found: nought, so no ring, and no re-query.
    expect(fixture.ledger.sats(stranger)).toBe(0)
    expect(fixture.changes()).toBeGreaterThan(0)
  })

  it('never puts a participant pubkey in a relay filter', async () => {
    const fixture = ledgerFixture()
    fixture.ledger.want([donor, otherDonor, stranger])
    await settle()
    expect(SpyTransport.filters).toEqual([{ kinds: [9735], '#p': [recipient] }])
    // Said plainly, because it is the whole of the privacy claim: the only
    // key that goes to a relay is the project's own.
    const asked = JSON.stringify(SpyTransport.filters)
    for (const key of [donor, otherDonor, stranger]) expect(asked).not.toContain(key)
  })

  it('holds a total for its lifetime, so a roster change re-queries nothing', async () => {
    const fixture = ledgerFixture()
    fixture.relay.publish(zapReceipt({ request: zapRequest(donorSk), bolt11: invoiceWith('lnbc1500u') }))
    fixture.ledger.want([donor])
    await settle()
    expect(SpyTransport.built).toBe(1)
    expect(fixture.fetches()).toBe(1)
    const subscriptions = SpyTransport.filters.length

    // Called again on the next render, and again with somebody who was
    // already covered by the sweep that has run.
    fixture.ledger.want([donor])
    fixture.ledger.want([donor, donor])
    await settle()
    expect(SpyTransport.filters.length).toBe(subscriptions)
    expect(fixture.ledger.sats(donor)).toBe(150_000)

    // Somebody new walking in is one more sweep, and the endpoint is not
    // asked twice.
    fixture.ledger.want([otherDonor])
    await settle()
    expect(SpyTransport.filters.length).toBe(subscriptions + 1)
    expect(fixture.fetches()).toBe(1)
    expect(SpyTransport.built).toBe(1)

    // Once the total goes stale it is looked up again, so a donation made
    // during a meeting shows up in the same meeting.
    fixture.advance(60_001)
    fixture.ledger.want([donor])
    await settle()
    expect(SpyTransport.filters.length).toBe(subscriptions + 2)
  })

  it('goes dark when the address advertises no signer', async () => {
    const fixture = ledgerFixture({ body: { allowsNostr: false } })
    fixture.relay.publish(zapReceipt({ request: zapRequest(donorSk), bolt11: invoiceWith('lnbc1500u') }))
    fixture.ledger.want([donor])
    await settle()
    // Nothing was read, because there is no key to read it against.
    expect(SpyTransport.filters).toEqual([])
    expect(fixture.ledger.sats(donor)).toBe(0)
  })

  it('credits nothing from a relay full of forgeries', async () => {
    const fixture = ledgerFixture()
    // One of each: a receipt signed by the wrong key, a real provider
    // signature over a request relabelled to this donor, and a genuine
    // donation to somebody else at the same custodial wallet.
    fixture.relay.publish(zapReceipt({ request: zapRequest(donorSk), sk: generateSecretKey(), bolt11: invoiceWith('lnbc9m') }))
    fixture.relay.publish(zapReceipt({ request: { ...zapRequest(otherDonorSk), pubkey: donor }, bolt11: invoiceWith('lnbc9m') }))
    fixture.relay.publish(zapReceipt({ request: zapRequest(donorSk, { to: stranger }), to: stranger, bolt11: invoiceWith('lnbc9m') }))
    fixture.ledger.want([donor])
    await settle()
    expect(fixture.ledger.sats(donor)).toBe(0)
    expect(ringTier({ nostr: true, sats: fixture.ledger.sats(donor) })).toBeUndefined()
  })

  it('stops when it is closed', async () => {
    const fixture = ledgerFixture()
    fixture.ledger.close()
    fixture.ledger.want([donor])
    await settle()
    expect(fixture.fetches()).toBe(0)
    expect(SpyTransport.built).toBe(0)
  })
})
