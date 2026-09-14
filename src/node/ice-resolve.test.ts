import { describe, it, expect, vi } from 'vitest'
import { resolveNodeIceServers } from './ice-resolve.js'

/** A fake `fetch` that answers exactly one way, and records what it was
 *  called with - a plain function rather than a mocking library, since
 *  `typeof fetch` is the only shape resolveNodeIceServers actually needs. */
function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    return respond(url, init)
  }) as typeof fetch
  return { fn, calls }
}

const credentialBody = {
  urls: ['turn:turn.kithmoot.example:3478', 'turns:turn.kithmoot.example:5349'],
  username: 'km-abc123',
  credential: 'sekrit',
  ttl: 3600,
}

describe('resolveNodeIceServers', () => {
  it('fetches <origin>/turn and derives STUN alongside the returned TURN urls and credential', async () => {
    const { fn, calls } = fakeFetch(() => new Response(JSON.stringify(credentialBody), { status: 200 }))
    const result = await resolveNodeIceServers({ origin: 'https://kithmoot.example/j/', fetchImpl: fn })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://kithmoot.example/turn')
    expect(result.turn).toEqual({ username: 'km-abc123', credential: 'sekrit' })
    expect(result.iceUrls).toEqual([
      'stun:turn.kithmoot.example:3478',
      'turn:turn.kithmoot.example:3478',
      'turns:turn.kithmoot.example:5349',
    ])
  })

  it('sends no Origin header - a plain Node fetch has none to send, and setting one risks a 403 an omitted one would not', async () => {
    const { fn, calls } = fakeFetch(() => new Response(JSON.stringify(credentialBody), { status: 200 }))
    await resolveNodeIceServers({ origin: 'https://kithmoot.example/j/', fetchImpl: fn })

    const headers = calls[0]!.init?.headers
    expect(headers === undefined || new Headers(headers).get('origin') === null).toBe(true)
  })

  it('falls back to a same-host STUN guess when /turn answers with something unusable', async () => {
    const { fn } = fakeFetch(() => new Response('not found', { status: 404 }))
    const result = await resolveNodeIceServers({ origin: 'https://kithmoot.example/j/', fetchImpl: fn })
    expect(result).toEqual({ iceUrls: ['stun:kithmoot.example:3478'] })
  })

  it('falls back the same way when the fetch itself throws', async () => {
    const fn = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const result = await resolveNodeIceServers({ origin: 'https://kithmoot.example/j/', fetchImpl: fn })
    expect(result).toEqual({ iceUrls: ['stun:kithmoot.example:3478'] })
  })

  it('falls back the same way when the credential body is missing required fields', async () => {
    const { fn } = fakeFetch(() => new Response(JSON.stringify({ urls: [], username: '', credential: '' }), { status: 200 }))
    const result = await resolveNodeIceServers({ origin: 'https://kithmoot.example/j/', fetchImpl: fn })
    expect(result).toEqual({ iceUrls: ['stun:kithmoot.example:3478'] })
  })

  it('names nothing at all on a localhost origin, even when /turn is unreachable', async () => {
    const { fn } = fakeFetch(() => new Response('not found', { status: 404 }))
    const result = await resolveNodeIceServers({ origin: 'https://localhost:4173/j/', fetchImpl: fn })
    expect(result).toEqual({ iceUrls: [] })
  })

  it('names nothing at all on a plain http origin', async () => {
    const { fn } = fakeFetch(() => new Response('not found', { status: 404 }))
    const result = await resolveNodeIceServers({ origin: 'http://kithmoot.example/j/', fetchImpl: fn })
    expect(result).toEqual({ iceUrls: [] })
  })

  it('times out rather than hanging on a slow /turn, and falls back', async () => {
    vi.useFakeTimers()
    try {
      const fn = ((_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as typeof fetch
      const promise = resolveNodeIceServers({ origin: 'https://kithmoot.example/j/', fetchImpl: fn })
      await vi.runAllTimersAsync()
      expect(await promise).toEqual({ iceUrls: ['stun:kithmoot.example:3478'] })
    } finally {
      vi.useRealTimers()
    }
  })
})
