/**
 * An L402 client, for the one process in this system with a reason to hold a
 * wallet.
 *
 * `deploy/l402/` puts an L402 paywall in front of a TURN credential endpoint.
 * Something has to answer the 402, pay the invoice and come back with the
 * token - and that something is deliberately not a browser. A participant is
 * never asked to pay to be in a room, so this is Node-only and lives beside
 * the agent and the keeper, which already run continuously and are the
 * natural place for a wallet.
 *
 * The flow, which is the whole of L402:
 *
 *   GET /turn                     -> 402, WWW-Authenticate: L402 macaroon=.., invoice=..
 *   pay the invoice               -> preimage
 *   GET /turn                     -> 200, with Authorization: L402 <macaroon>:<preimage>
 *
 * The macaroon and preimage together are a bearer token. This caches it and
 * re-sends it, because paying once per request rather than once per token
 * would turn a ten-satoshi credential into ten satoshis every time anything
 * retried.
 */

/**
 * Something that can pay a BOLT11 invoice and hand back its preimage, as 64
 * lowercase hex characters.
 *
 * One method, so a test can hand in a fake and a person can hand in whatever
 * they run. `nwc-kit`'s `NwcClient.payInvoice` satisfies this in three lines
 * (see `nwcPayer` below); so would an LND client, a Phoenixd client, or a
 * human with a QR code and a lot of patience.
 *
 * Throwing is how a payer refuses. A payer that cannot pay must throw rather
 * than return something falsy, so a refusal is never mistaken for a preimage.
 */
export interface Payer {
  pay(invoice: string): Promise<string>
}

/** A token that has already been paid for, ready to re-send. */
export interface L402Token {
  macaroon: string
  preimage: string
}

export interface L402Challenge {
  macaroon: string
  invoice: string
}

/** Multiplier for each BOLT11 amount suffix, in millisatoshis per unit.
 *
 *  1 BTC is 10^11 msat, so `m` (10^-3 BTC) is 10^8 msat, and so on down. `p`
 *  is a tenth of a millisatoshi, which is why it is handled separately below
 *  rather than being allowed to produce a fractional msat. */
const MSAT_PER_UNIT: Record<string, number> = {
  m: 100_000_000,
  u: 100_000,
  n: 100,
}

/**
 * Reads the amount out of a BOLT11 invoice, in millisatoshis.
 *
 * Returns null for an invoice with no amount in it. That is not an error in
 * BOLT11 - an amountless invoice means "pay what you like" - but it is one
 * here, because an amount is what a budget is checked against. `payL402`
 * refuses rather than guessing.
 *
 * This reads only the human-readable part, which is everything before the
 * bech32 separator. It does not verify the invoice: a caller is paying it
 * through a real wallet, which will do that properly. The only question
 * being asked here is "is this within budget", and the answer has to be
 * available before any money moves.
 *
 * The separator is the *last* `1` in the string, not the first: the bech32
 * charset excludes `1`, so the data part cannot contain one, but the
 * human-readable part can. In `lnbc1u1...` - one micro-bitcoin, so a hundred
 * satoshis - the first `1` is the amount and the second is the separator.
 */
export function bolt11AmountMsat(invoice: string): number | null {
  const sep = invoice.lastIndexOf('1')
  if (sep <= 0) return null

  const hrp = invoice.slice(0, sep).toLowerCase()
  // lnbc (mainnet), lntb (testnet), lnbcrt (regtest), lntbs (signet). Longest
  // prefixes first, or `lnbc` swallows the start of `lnbcrt`.
  const m = /^ln(?:bcrt|tbs|bc|tb)(\d*)([munp]?)$/.exec(hrp)
  if (!m) return null

  const digits = m[1]
  const unit = m[2]
  if (digits === '') return null // no amount in the invoice

  const value = Number(digits)
  if (!Number.isFinite(value)) return null

  // No suffix means the amount is in whole bitcoin.
  if (unit === '') return value * 100_000_000_000

  if (unit === 'p') {
    // A tenth of a millisatoshi per unit. BOLT11 requires a `p` amount to be
    // a multiple of 10 for exactly this reason; anything else is not
    // representable and is refused rather than rounded, because rounding a
    // payment amount down is a bug and rounding it up spends more money than
    // was asked for.
    if (value % 10 !== 0) return null
    return value / 10
  }

  const per = MSAT_PER_UNIT[unit]
  return per === undefined ? null : value * per
}

/**
 * Parses a `WWW-Authenticate` header into a challenge.
 *
 * Accepts both the `L402` scheme and the older `LSAT` one. Aperture emitted
 * `LSAT` for years and some deployments still do, and a client that only
 * understands the new name silently fails to pay a server that is otherwise
 * working perfectly.
 *
 * Returns null on anything it does not understand, rather than throwing or
 * half-parsing: the caller's next move on a challenge it cannot read is to
 * give up, and that is easier to get right against a null than an exception.
 */
export function parseL402Challenge(header: string | null | undefined): L402Challenge | null {
  if (!header) return null

  const scheme = /^\s*(L402|LSAT)\s+(.*)$/is.exec(header)
  if (!scheme) return null

  const params = scheme[2]
  const macaroon = /(?:^|[,\s])macaroon\s*=\s*"?([A-Za-z0-9+/=_-]+)"?/i.exec(params)?.[1]
  const invoice = /(?:^|[,\s])invoice\s*=\s*"?(ln[a-z0-9]+)"?/i.exec(params)?.[1]

  if (!macaroon || !invoice) return null
  return { macaroon, invoice }
}

/** The `Authorization` header value for a token. */
export function l402Authorization(token: L402Token): string {
  return `L402 ${token.macaroon}:${token.preimage}`
}

/**
 * The slice of `fetch` this module actually uses.
 *
 * Declared narrowly rather than as `typeof globalThis.fetch` so a fake is a
 * two-line function rather than something that has to satisfy the whole DOM
 * signature. The real `fetch` accepts wider arguments than this and so is
 * assignable to it, which is the direction that matters.
 */
export type L402Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>

export interface L402FetchOptions {
  /** Injected so a test can hand in a fake, and so a caller can supply one
   *  with its own timeouts, proxy or agent. Defaults to global fetch. */
  fetch?: L402Fetch
  /** Pays invoices. Without one, a 402 is simply a failure - which is the
   *  right default: a process that can spend money should have said so. */
  payer?: Payer
  /** The most this call may spend, in millisatoshis. There is no default and
   *  none is coming: a payer with no cap is a wallet drainer, and the whole
   *  point of the endpoint being cheap is that the cap can be tight. */
  maxMsat?: number
  /** A token already paid for. Tried first; a 402 in response to it means it
   *  has expired or been spent, and a fresh one is bought if a payer allows. */
  token?: L402Token
}

export interface L402Response {
  response: Response
  /** The token that got in, whether it was handed in or bought just now.
   *  Keep it and pass it back next time rather than paying again. */
  token?: L402Token
  /** True when this call actually spent money. */
  paid: boolean
}

/**
 * Fetches a URL, paying an L402 challenge if one comes back.
 *
 * Returns the response rather than its body, so a caller reads it however it
 * likes and a non-402 error is the caller's to interpret. Only the 402 is
 * handled here.
 *
 * A second 402 after paying is not retried. That is either a server that is
 * not honouring its own tokens or a preimage that did not satisfy it, and
 * paying twice to find out is the wrong instinct.
 */
export async function l402Fetch(url: string, options: L402FetchOptions = {}): Promise<L402Response> {
  const doFetch = options.fetch ?? globalThis.fetch
  const headers: Record<string, string> = {}
  if (options.token) headers.authorization = l402Authorization(options.token)

  const first = await doFetch(url, { headers })
  if (first.status !== 402) return { response: first, token: options.token, paid: false }

  if (!options.payer) {
    throw new Error(
      `l402Fetch: ${url} wants payment and no payer was given. ` +
        'Pass a payer to spend, or handle the 402 yourself.',
    )
  }

  const challenge = parseL402Challenge(first.headers.get('www-authenticate'))
  if (!challenge) {
    throw new Error(
      `l402Fetch: ${url} answered 402 with no L402 challenge this client could read ` +
        `(www-authenticate: ${first.headers.get('www-authenticate') ?? 'absent'}).`,
    )
  }

  if (options.maxMsat === undefined) {
    throw new Error('l402Fetch: refusing to pay without maxMsat. An uncapped payer empties a wallet.')
  }

  const amount = bolt11AmountMsat(challenge.invoice)
  if (amount === null) {
    throw new Error(
      `l402Fetch: ${url} asked for payment with an invoice carrying no readable amount. ` +
        'Refusing, because an amount is what the budget is checked against.',
    )
  }
  if (amount > options.maxMsat) {
    throw new Error(
      `l402Fetch: ${url} asked for ${amount} msat, over the ${options.maxMsat} msat cap. Not paying.`,
    )
  }

  const preimage = await options.payer.pay(challenge.invoice)
  if (!/^[0-9a-f]{64}$/i.test(preimage)) {
    throw new Error('l402Fetch: the payer returned something that is not a 32-byte hex preimage.')
  }

  const token: L402Token = { macaroon: challenge.macaroon, preimage: preimage.toLowerCase() }
  const second = await doFetch(url, { headers: { authorization: l402Authorization(token) } })
  return { response: second, token, paid: true }
}

/**
 * Wraps anything with `nwc-kit`'s `payInvoice` shape as a `Payer`.
 *
 * Structurally typed rather than importing `nwc-kit`, so this module stays
 * dependency-free and a caller who uses a different wallet is not made to
 * install one they do not use. `NwcClient` satisfies the parameter as it is.
 */
export function nwcPayer(client: { payInvoice(params: { invoice: string }): Promise<{ preimage: string }> }): Payer {
  return {
    async pay(invoice: string): Promise<string> {
      const { preimage } = await client.payInvoice({ invoice })
      return preimage
    },
  }
}
