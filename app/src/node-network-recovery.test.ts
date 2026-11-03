import { describe, it, expect, vi } from 'vitest'
import { watchNodeNetwork } from './node-network-recovery.js'

describe('node network recovery triggers', () => {
  it('ignores estimated quality changes and reconnects on a physical network change or online event', () => {
    const window = new EventTarget(), connection = Object.assign(new EventTarget(), { type: 'wifi', effectiveType: '4g', rtt: 20 })
    const reconnect = vi.fn(), close = watchNodeNetwork(window, connection, reconnect)
    connection.effectiveType = '3g'; connection.rtt = 500; connection.dispatchEvent(new Event('change'))
    expect(reconnect).not.toHaveBeenCalled()
    connection.type = 'cellular'; connection.dispatchEvent(new Event('change'))
    expect(reconnect).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('online')); expect(reconnect).toHaveBeenCalledTimes(2)
    close(); connection.type = 'wifi'; connection.dispatchEvent(new Event('change')); window.dispatchEvent(new Event('online'))
    expect(reconnect).toHaveBeenCalledTimes(2)
  })
  it('uses the online event where physical network type is unavailable', () => {
    const window = new EventTarget(), connection = Object.assign(new EventTarget(), { effectiveType: '4g' })
    const reconnect = vi.fn(), close = watchNodeNetwork(window, connection, reconnect)
    connection.effectiveType = '3g'; connection.dispatchEvent(new Event('change')); expect(reconnect).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('online')); expect(reconnect).toHaveBeenCalledOnce(); close()
  })
})
