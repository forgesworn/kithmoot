import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('../test/relay-pool-node-connecting.mjs', import.meta.url))
function run(mode: string) {
  return new Promise<{ code: string | number | null; rows: Record<string, unknown>[] }>(resolve => {
    // The production publication retry budget is 20s, followed by closure.
    execFile(process.execPath, [fixture, mode], { timeout: 30_000 }, (error, stdout) => {
      resolve({ code: error ? error.code ?? error.signal ?? 'failed' : null,
        rows: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) })
    })
  })
}

describe('abandoned real Node WebSocket handshakes', () => {
  it('rejects the publish and closes the failed handshake without terminating the process', async () => {
    const result = await run('bare')
    expect(result.code).toBeNull()
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]!
    expect(row.created).toBeGreaterThan(0)
    expect(row.created).toBeLessThanOrEqual(5)
    expect(row).toMatchObject({ rejected: true, closed: row.created,
      remainingSockets: 0, remainingErrorListeners: Array(row.created as number).fill(0), allSocketsClosed: true })
  }, 35_000)

  it('keeps existing socket error observers and removes only its own closure listener', async () => {
    const result = await run('observer')
    expect(result.code).toBeNull()
    const row = result.rows[0]!
    expect(row.created).toBeGreaterThan(0)
    expect(row.created).toBeLessThanOrEqual(5)
    expect(row).toMatchObject({ rejected: true, closed: row.created, existingErrors: row.created,
      remainingSockets: 0, remainingErrorListeners: Array(row.created as number).fill(1), allSocketsClosed: true })
  }, 35_000)

  it('preserves default fatal handling for an unrelated uncaught exception', async () => {
    const result = await run('unrelated')
    expect(result.code).not.toBeNull()
    expect(result.rows).toEqual([{ fatalAbandonedHandshake: false }])
  }, 20_000)
})
