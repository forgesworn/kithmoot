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
      expect(lines.join('')).toContain('--zap must be a Lightning address')
    }
  })
})
