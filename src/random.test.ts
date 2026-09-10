import { afterEach, expect, it, vi } from 'vitest'
import { randomFraction } from './random.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('uses fresh cryptographic draws while keeping timing fractions below one', () => {
  const words = [0, 0xffff_ffff]
  const draw = vi.fn((target: Uint32Array) => { target[0] = words.shift()!; return target })
  vi.stubGlobal('crypto', { getRandomValues: draw })
  vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('predictable randomness used') })
  expect(randomFraction()).toBe(0)
  const upper = randomFraction()
  expect(upper).toBeGreaterThan(0.999999)
  expect(upper).toBeLessThan(1)
  expect(draw).toHaveBeenCalledTimes(2)
})

it('fails when the CSPRNG is unavailable instead of silently using predictable timing', () => {
  vi.stubGlobal('crypto', undefined)
  const predictable = vi.spyOn(Math, 'random')
  expect(() => randomFraction()).toThrow()
  expect(predictable).not.toHaveBeenCalled()
})
