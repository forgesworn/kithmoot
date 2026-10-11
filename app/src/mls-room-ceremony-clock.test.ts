import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserMlsRoomCeremonyClock } from './mls-room-ceremony-clock.js'

function fixture() {
  let wall = 1_793_577_600_000, mono = 100
  vi.spyOn(Date, 'now').mockImplementation(() => wall)
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
  const clock = new BrowserMlsRoomCeremonyClock()
  return { clock, advance: (wallMs: number, monoMs = wallMs) => { wall += wallMs; mono += monoMs } }
}
afterEach(() => vi.restoreAllMocks())
describe('bounded room creation clock', () => {
  it('captures before work and remains current only inside the ten-minute window', () => {
    const f = fixture()
    expect(f.clock.deadline).toBe(1_793_578_200)
    f.advance(599_999); expect(f.clock.current()).toBe(true)
    f.advance(1); expect(f.clock.current()).toBe(false)
  })
  it.each(['wall', 'monotonic'] as const)('expires when the %s clock reaches the boundary', source => {
    const f = fixture(); f.advance(source === 'wall' ? 600_000 : 1, source === 'monotonic' ? 600_000 : 1)
    expect(f.clock.read()).toBeUndefined()
  })
  it.each(['wall', 'monotonic'] as const)('permanently refuses %s regression, even if it later catches up', source => {
    const f = fixture(); f.advance(1000); expect(f.clock.current()).toBe(true)
    f.advance(source === 'wall' ? -1 : 1, source === 'monotonic' ? -1 : 1)
    expect(f.clock.current()).toBe(false)
    f.advance(5000); expect(f.clock.current()).toBe(false)
  })
  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])('refuses invalid wall clock %s', value => {
    const f = fixture(); vi.mocked(Date.now).mockReturnValue(value)
    expect(f.clock.current()).toBe(false)
  })
  it('does not revive after a clock accessor failure', () => {
    const f = fixture(); vi.mocked(Date.now).mockImplementationOnce(() => { throw new Error('clock unavailable') })
    expect(f.clock.current()).toBe(false); expect(f.clock.current()).toBe(false)
  })
})
