import { afterEach, expect, test, vi } from 'vitest'
import { updateAppBadge } from './app-badge.js'
afterEach(() => vi.unstubAllGlobals())
test('badge updates stay ordered and recover after a denied permission', async () => {
  const calls: number[] = []
  vi.stubGlobal('navigator', {
    setAppBadge: async (n: number) => { await new Promise(resolve => setTimeout(resolve, 5)); calls.push(n); if (n === 1) throw new Error('Denied') },
    clearAppBadge: async () => { calls.push(0) },
  })
  updateAppBadge(1); updateAppBadge(2); updateAppBadge(0)
  await vi.waitFor(() => expect(calls).toEqual([1, 2, 0]))
})
