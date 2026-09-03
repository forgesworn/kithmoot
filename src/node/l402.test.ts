import { describe, it, expect, vi } from 'vitest'
import {
  bolt11AmountMsat,
  parseL402Challenge,
  l402Authorization,
  l402Fetch,
  nwcPayer,
  type Payer,
  type L402Fetch,
} from './l402.js'

/** 32 bytes of hex, the shape a real preimage has. */
const PREIMAGE = 'a'.repeat(64)

/** A 10-satoshi mainnet invoice: 100 nano-bitcoin. Only the human-readable
 *  part is ever parsed, so the data part need only be bech32-legal
 *  characters - `1` is not one of them, which is what makes the separator
 *  findable. */
const INVOICE_10_SAT = 'lnbc100n1pjqweasdfghjkzxcvbnmqwertyuiop'

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 402 ? null : '{"ok":true}', { status, headers })
}

describe('bolt11AmountMsat', () => {
  it('reads nano-bitcoin, the unit a ten-satoshi invoice uses', () => {
    // 100n = 100 x 10^-9 BTC = 10 sat = 10,000 msat
    expect(bolt11AmountMsat(INVOICE_10_SAT)).toBe(10_000)
  })

  it('reads micro-bitcoin', () => {
    // 1u = 10^-6 BTC = 100 sat
    expect(bolt11AmountMsat('lnbc1u1pqwerty')).toBe(100_000)
  })

  it('reads milli-bitcoin', () => {
    // 2m = 2 x 10^-3 BTC = 200,000 sat
    expect(bolt11AmountMsat('lnbc2m1pqwerty')).toBe(200_000_000)
  })

  it('reads a bare amount as whole bitcoin', () => {
    expect(bolt11AmountMsat('lnbc21pqwerty')).toBe(2 * 100_000_000_000)
  })

  it('reads pico-bitcoin as tenths of a millisatoshi', () => {
    // 10p = 1 msat
    expect(bolt11AmountMsat('lnbc10p1pqwerty')).toBe(1)
  })

  it('refuses a pico amount that is not a multiple of ten', () => {
    // Not representable in millisatoshis. Rounding down underpays and
    // rounding up spends more than was asked for, so neither happens.
    expect(bolt11AmountMsat('lnbc7p1pqwerty')).toBeNull()
  })

  it('returns null for an invoice with no amount', () => {
    // Legal BOLT11 - "pay what you like" - but a budget cannot be checked
    // against it, so it is refused rather than guessed at.
    expect(bolt11AmountMsat('lnbc1pqwerty')).toBeNull()
  })

  it('reads testnet, signet and regtest prefixes', () => {
    expect(bolt11AmountMsat('lntb100n1pqwerty')).toBe(10_000)
    expect(bolt11AmountMsat('lntbs100n1pqwerty')).toBe(10_000)
    expect(bolt11AmountMsat('lnbcrt100n1pqwerty')).toBe(10_000)
  })

  it('does not let the bc prefix swallow the start of bcrt', () => {
    // The alternation must try the longer prefix first, or `lnbcrt100n`
    // parses as prefix `bc` with a leftover `rt100n` that matches nothing.
    expect(bolt11AmountMsat('lnbcrt100n1pqwerty')).not.toBeNull()
  })

  it('returns null for something that is not an invoice', () => {
    expect(bolt11AmountMsat('not-an-invoice')).toBeNull()
    expect(bolt11AmountMsat('')).toBeNull()
    expect(bolt11AmountMsat('lnxx100n1pqwerty')).toBeNull()
  })

  it('takes the last 1 as the separator, not the first', () => {
    // The amount itself contains a 1. Taking the first would truncate the
    // human-readable part and read the wrong amount.
    expect(bolt11AmountMsat('lnbc100n1pqwerty')).toBe(10_000)
    expect(bolt11AmountMsat('lnbc1u1pqwerty')).toBe(100_000)
  })
})

describe('parseL402Challenge', () => {
  it('parses a standard Aperture challenge', () => {
    const header = `L402 macaroon="AGIAJEemVQUTEyNCR0exk7ek90Cg==", invoice="${INVOICE_10_SAT}"`
    expect(parseL402Challenge(header)).toEqual({
      macaroon: 'AGIAJEemVQUTEyNCR0exk7ek90Cg==',
      invoice: INVOICE_10_SAT,
    })
  })

  it('accepts the older LSAT scheme name', () => {
    // Aperture emitted LSAT for years and some deployments still do. A
    // client that only knows the new name silently fails to pay a server
    // that is working perfectly.
    const header = `LSAT macaroon="abc123", invoice="${INVOICE_10_SAT}"`
    expect(parseL402Challenge(header)?.macaroon).toBe('abc123')
  })

  it('does not care what order the parameters come in', () => {
    const header = `L402 invoice="${INVOICE_10_SAT}", macaroon="abc123"`
    expect(parseL402Challenge(header)).toEqual({ macaroon: 'abc123', invoice: INVOICE_10_SAT })
  })

  it('accepts unquoted values', () => {
    expect(parseL402Challenge(`L402 macaroon=abc123, invoice=${INVOICE_10_SAT}`)).toEqual({
      macaroon: 'abc123',
      invoice: INVOICE_10_SAT,
    })
  })

  it('returns null rather than half a challenge when a part is missing', () => {
    expect(parseL402Challenge('L402 macaroon="abc123"')).toBeNull()
    expect(parseL402Challenge(`L402 invoice="${INVOICE_10_SAT}"`)).toBeNull()
  })

  it('returns null for another scheme, an empty header or none at all', () => {
    expect(parseL402Challenge('Bearer abc')).toBeNull()
    expect(parseL402Challenge('')).toBeNull()
    expect(parseL402Challenge(null)).toBeNull()
    expect(parseL402Challenge(undefined)).toBeNull()
  })
})

describe('l402Authorization', () => {
  it('joins the macaroon and preimage with a colon', () => {
    expect(l402Authorization({ macaroon: 'abc', preimage: PREIMAGE })).toBe(`L402 abc:${PREIMAGE}`)
  })
})

describe('l402Fetch', () => {
  const challenge = { 'www-authenticate': `L402 macaroon="mac123", invoice="${INVOICE_10_SAT}"` }

  it('returns a 200 untouched, without paying anything', async () => {
    const fetch = vi.fn<L402Fetch>(async () => res(200))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }

    const out = await l402Fetch('https://turn.example/turn', { fetch, payer, maxMsat: 100_000 })

    expect(out.paid).toBe(false)
    expect(out.response.status).toBe(200)
    expect(payer.pay).not.toHaveBeenCalled()
  })

  it('pays a 402 and retries with the token', async () => {
    const fetch = vi
      .fn<L402Fetch>()
      .mockResolvedValueOnce(res(402, challenge))
      .mockResolvedValueOnce(res(200))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }

    const out = await l402Fetch('https://turn.example/turn', { fetch, payer, maxMsat: 100_000 })

    expect(payer.pay).toHaveBeenCalledWith(INVOICE_10_SAT)
    expect(out.paid).toBe(true)
    expect(out.response.status).toBe(200)
    expect(out.token).toEqual({ macaroon: 'mac123', preimage: PREIMAGE })

    const retryHeaders = fetch.mock.calls[1][1].headers
    expect(retryHeaders.authorization).toBe(`L402 mac123:${PREIMAGE}`)
  })

  it('sends a token it was given, and does not pay when that works', async () => {
    const fetch = vi.fn<L402Fetch>(async () => res(200))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }
    const token = { macaroon: 'mac123', preimage: PREIMAGE }

    const out = await l402Fetch('https://turn.example/turn', {
      fetch,
      payer,
      maxMsat: 100_000,
      token,
    })

    expect(fetch.mock.calls[0][1].headers.authorization).toBe(`L402 mac123:${PREIMAGE}`)
    expect(payer.pay).not.toHaveBeenCalled()
    expect(out.paid).toBe(false)
    expect(out.token).toBe(token)
  })

  it('buys a fresh token when the one it held is refused', async () => {
    const fetch = vi
      .fn<L402Fetch>()
      .mockResolvedValueOnce(res(402, challenge))
      .mockResolvedValueOnce(res(200))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }

    const out = await l402Fetch('https://turn.example/turn', {
      fetch,
      payer,
      maxMsat: 100_000,
      token: { macaroon: 'stale', preimage: 'b'.repeat(64) },
    })

    expect(out.paid).toBe(true)
    expect(out.token?.macaroon).toBe('mac123')
  })

  it('does not pay twice when the server refuses its own token', async () => {
    // A second 402 after paying means the server is not honouring what it
    // sold, or the preimage did not satisfy it. Paying again to find out is
    // the wrong instinct.
    const fetch = vi.fn<L402Fetch>(async () => res(402, challenge))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }

    const out = await l402Fetch('https://turn.example/turn', { fetch, payer, maxMsat: 100_000 })

    expect(payer.pay).toHaveBeenCalledTimes(1)
    expect(out.response.status).toBe(402)
  })

  it('refuses to pay without a cap', async () => {
    const fetch = vi.fn<L402Fetch>(async () => res(402, challenge))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }

    await expect(l402Fetch('https://turn.example/turn', { fetch, payer })).rejects.toThrow(
      /refusing to pay without maxMsat/,
    )
    expect(payer.pay).not.toHaveBeenCalled()
  })

  it('refuses an invoice over the cap, without paying it', async () => {
    const fetch = vi.fn<L402Fetch>(async () => res(402, challenge))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }

    // The invoice is 10,000 msat; the cap is 9,999.
    await expect(
      l402Fetch('https://turn.example/turn', { fetch, payer, maxMsat: 9_999 }),
    ).rejects.toThrow(/over the 9999 msat cap/)
    expect(payer.pay).not.toHaveBeenCalled()
  })

  it('pays an invoice exactly at the cap', async () => {
    const fetch = vi
      .fn<L402Fetch>()
      .mockResolvedValueOnce(res(402, challenge))
      .mockResolvedValueOnce(res(200))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }

    const out = await l402Fetch('https://turn.example/turn', { fetch, payer, maxMsat: 10_000 })
    expect(out.paid).toBe(true)
  })

  it('refuses an amountless invoice rather than paying an unknown sum', async () => {
    const fetch = vi.fn<L402Fetch>(async () => res(402, { 'www-authenticate': 'L402 macaroon="m", invoice="lnbc1pqwerty"' }))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }

    await expect(
      l402Fetch('https://turn.example/turn', { fetch, payer, maxMsat: 100_000 }),
    ).rejects.toThrow(/no readable amount/)
    expect(payer.pay).not.toHaveBeenCalled()
  })

  it('fails on a 402 when no payer was given, and says so', async () => {
    const fetch = vi.fn<L402Fetch>(async () => res(402, challenge))
    await expect(l402Fetch('https://turn.example/turn', { fetch })).rejects.toThrow(
      /wants payment and no payer was given/,
    )
  })

  it('fails on a 402 whose challenge it cannot read', async () => {
    const fetch = vi.fn<L402Fetch>(async () => res(402, { 'www-authenticate': 'Bearer nope' }))
    const payer: Payer = { pay: vi.fn(async () => PREIMAGE) }

    await expect(
      l402Fetch('https://turn.example/turn', { fetch, payer, maxMsat: 100_000 }),
    ).rejects.toThrow(/no L402 challenge this client could read/)
  })

  it('rejects a payer that returns something that is not a preimage', async () => {
    const fetch = vi.fn<L402Fetch>(async () => res(402, challenge))
    const payer: Payer = { pay: vi.fn(async () => 'not-a-preimage') }

    await expect(
      l402Fetch('https://turn.example/turn', { fetch, payer, maxMsat: 100_000 }),
    ).rejects.toThrow(/not a 32-byte hex preimage/)
  })

  it('lower-cases the preimage it stores', async () => {
    const fetch = vi
      .fn<L402Fetch>()
      .mockResolvedValueOnce(res(402, challenge))
      .mockResolvedValueOnce(res(200))
    const payer: Payer = { pay: async () => 'A'.repeat(64) }

    const out = await l402Fetch('https://turn.example/turn', { fetch, payer, maxMsat: 100_000 })
    expect(out.token?.preimage).toBe('a'.repeat(64))
  })
})

describe('nwcPayer', () => {
  it('adapts an nwc-kit client to a Payer', async () => {
    const client = { payInvoice: vi.fn(async () => ({ preimage: PREIMAGE })) }
    const payer = nwcPayer(client)

    expect(await payer.pay(INVOICE_10_SAT)).toBe(PREIMAGE)
    expect(client.payInvoice).toHaveBeenCalledWith({ invoice: INVOICE_10_SAT })
  })

  it('lets a refusal from the wallet through rather than swallowing it', async () => {
    const client = {
      payInvoice: async () => {
        throw new Error('insufficient balance')
      },
    }
    await expect(nwcPayer(client).pay(INVOICE_10_SAT)).rejects.toThrow(/insufficient balance/)
  })
})
