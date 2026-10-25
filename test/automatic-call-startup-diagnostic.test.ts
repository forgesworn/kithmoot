import { afterEach, expect, it, vi } from 'vitest'
import type { Page } from '@playwright/test'
import { rethrowStartupFailure } from './automatic-call-startup-diagnostic.js'

afterEach(() => { vi.useRealTimers() })
it('preserves the original failure when navigation destroys diagnostic evaluation', async () => {
  const original = new Error('original creation failure')
  const page = { evaluate: vi.fn(async () => { throw new Error('Execution context destroyed') }) } as unknown as Pick<Page, 'evaluate'>
  const emit = vi.fn()
  await expect(rethrowStartupFailure(original, page, [], emit)).rejects.toBe(original)
  expect(emit).toHaveBeenCalledWith({ issues: [], page: { available: false } })
})
it('preserves the original failure when diagnostic reporting itself fails', async () => {
  const original = new Error('original creation failure')
  const page = { evaluate: vi.fn(async () => undefined) } as unknown as Pick<Page, 'evaluate'>
  await expect(rethrowStartupFailure(original, page, [], () => { throw new Error('report failed') })).rejects.toBe(original)
})
it('caps evidence and emits only allowlisted categories and DOM flags', async () => {
  const original = new Error('original creation failure'), forbidden = 'private-key-or-room-payload'
  const page = { evaluate: vi.fn(async () => ({ ready: 'complete', startupPresent: true, startupReady: false,
    newRoomVisible: true, createVisible: false, roomVisible: false, text: forbidden, url: forbidden, storage: forbidden })) } as unknown as Pick<Page, 'evaluate'>
  const emit = vi.fn()
  await expect(rethrowStartupFailure(original, page, Array.from({ length: 20 }, () => ({ kind: 'http-error', status: 503,
    resource: forbidden, category: forbidden, payload: forbidden })), emit)).rejects.toBe(original)
  const diagnostic = emit.mock.calls[0]![0]
  expect(diagnostic.issues).toHaveLength(12)
  expect(diagnostic.issues[0]).toEqual({ kind: 'http-error', category: 'other', resource: 'other', status: 503 })
  expect(JSON.stringify(diagnostic).includes(forbidden)).toBe(false)
  expect(diagnostic.page).toEqual({ available: true, ready: 'complete', startupPresent: true, startupReady: false,
    newRoomVisible: true, createVisible: false, roomVisible: false })
})
it('bounds a stalled diagnostic without waiting for the page to recover', async () => {
  vi.useFakeTimers()
  const original = new Error('original creation failure')
  const page = { evaluate: vi.fn(() => new Promise(() => {})) } as unknown as Pick<Page, 'evaluate'>
  const pending = rethrowStartupFailure(original, page, [], () => {}, 20)
  const rejected = expect(pending).rejects.toBe(original)
  await vi.advanceTimersByTimeAsync(21)
  await rejected
})
