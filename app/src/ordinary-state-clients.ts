import { OrdinaryStateHold } from './ordinary-state-codec.js'
const PROTOCOL = 'kithmoot:ordinary-state-clients-v1'
const nonce = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2,'0')).join('')
/** An actual active-worker window inventory. It establishes compatibility at
 * the handshake point, not membership, hardware authority or perpetual absence
 * of future old windows. The embedding must stop on legacy reappearance and
 * repeat this fence at migration/forget and dependent effect boundaries. */
export class OrdinaryClientFence {
  #closed = false
  get live(): boolean { return !this.#closed }
  #changed = () => { this.#closed = true }
  #probe = async (event: MessageEvent) => {
    const value = event.data
    if (this.#closed || !value || value.protocol !== PROTOCOL || value.phase !== 'probe' ||
        typeof value.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(value.nonce) || event.ports.length !== 1) return
    try {
      const registration = await navigator.serviceWorker.getRegistration()
      if (this.#closed || event.source !== registration?.active) return
      event.ports[0]!.postMessage({ protocol: PROTOCOL, phase: 'ready', nonce: value.nonce })
    } catch { /* Unverifiable worker custody cannot acknowledge readiness. */ }
    finally { event.ports[0]?.close() }
  }
  constructor() {
    if (!navigator.serviceWorker || !navigator.locks) throw new OrdinaryStateHold()
    navigator.serviceWorker.addEventListener('message', this.#probe)
    navigator.serviceWorker.addEventListener('controllerchange', this.#changed)
  }
  async assertCurrent(): Promise<void> {
    const worker = navigator.serviceWorker.controller
    if (this.#closed || !worker || new URL(worker.scriptURL).origin !== location.origin) throw new OrdinaryStateHold()
    const token = nonce()
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel()
      let finished = false
      const finish = (ok: boolean) => {
        if (finished) return
        finished = true; clearTimeout(timer); channel.port1.close()
        ok && !this.#closed && worker === navigator.serviceWorker.controller ? resolve() : reject(new OrdinaryStateHold())
      }
      const timer = setTimeout(() => finish(false), 5_000)
      channel.port1.onmessage = event => {
        const value = event.data
        finish(!!value && value.protocol === PROTOCOL && value.phase === 'result' && value.nonce === token && value.ok === true)
      }
      channel.port1.onmessageerror = () => finish(false)
      try { worker.postMessage({ protocol: PROTOCOL, phase: 'check', nonce: token }, [channel.port2]) }
      catch { finish(false) }
    })
  }
  close(): void {
    this.#closed = true
    navigator.serviceWorker.removeEventListener('message', this.#probe)
    navigator.serviceWorker.removeEventListener('controllerchange', this.#changed)
  }
}
