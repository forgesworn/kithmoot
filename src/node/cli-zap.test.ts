import { describe, it, expect, vi, afterEach } from 'vitest'
import { main, zapOption } from './cli.js'

afterEach(() => { vi.restoreAllMocks() })

describe('--zap', () => {
  it('hands a valid address on, lower-cased, and nothing when absent', () => {
    expect(zapOption('Maker@Example.COM')).toBe('maker@example.com')
    expect(zapOption(undefined)).toBeUndefined()
  })

  it('refuses to start on a malformed address, with one line saying why', async () => {
    const lines: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { lines.push(String(s)); return true }) as never)
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)
    for (const bad of ['nope', 'a@b@example.com', 'maker@example.com:80']) {
      lines.length = 0
      const outcome = await main(['join', 'https://example.test/j/#x', '--name', 'Bot', '--zap', bad]).then(() => 'started', (e: Error) => e.message)
      expect(outcome).toBe('exit 2')
      expect(lines.join('')).toContain('must be a Lightning address')
    }
  })
})

describe('a stray KITHMOOT_ZAP', () => {
  it('does not stop a subcommand that never publishes a roster entry', async () => {
    const lines: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { lines.push(String(s)); return true }) as never)
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)
    vi.stubEnv('KITHMOOT_ZAP', 'nope')
    try {
      // attest fails for its own reasons here (no agent key given), never for the address.
      const outcome = await main(['attest']).then(() => 'ran', (e: Error) => e.message)
      expect(lines.join('')).not.toContain('must be a Lightning address')
      expect(outcome).not.toBe('')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
