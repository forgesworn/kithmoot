/** A public room pool holds a shared Web Lock until its sockets are closed.
 * Activation takes the exclusive lock after durable intent is saved. A
 * frozen tab still holds its shared lock, so silence can never count as
 * acknowledgement. Queued and newly opened tabs re-read consent under the
 * shared lock before constructing a public pool. Broadcasts are wake-ups,
 * not authority, and carry no room, account, grant or route metadata. */
export class BrowserRoomBarrier {
  #channel: BroadcastChannel
  #listeners = new Set<() => void>()
  #workerReady = (event: MessageEvent) => {
    if (event.data === 'kithmoot:room-route-ready-v1') event.ports[0]?.postMessage('ready')
  }
  constructor(private locks: LockManager = navigator.locks, channel = new BroadcastChannel('kithmoot.room-route-change.v1'), private checkTabs: () => Promise<void> = checkRoomTabs) {
    this.#channel = channel
    channel.onmessage = e => { if (e.data === 'changed') this.#changed() }
    navigator.serviceWorker?.addEventListener('message', this.#workerReady)
  }
  changed(): void { this.#changed(); this.#channel.postMessage('changed') }
  #changed(): void { for (const listener of this.#listeners) listener() }
  listen(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  async publicLease(room: string): Promise<() => Promise<void>> {
    if (!this.locks) return async () => {}
    let release!: () => void
    let acquired!: () => void
    let failed!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject })
    const held = this.locks.request(this.#name(room), { mode: 'shared' }, async () => {
      await new Promise<void>(resolve => { release = resolve; acquired() })
    })
    void held.catch(failed)
    await ready
    return async () => { release(); await held }
  }
  async closed(room: string, work: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
    if (!this.locks) throw new Error('Bothy room activation needs Web Locks.')
    await this.checkTabs()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      this.changed()
      await this.locks.request(this.#name(room), { mode: 'exclusive', signal: abort.signal }, async () => {
        clearTimeout(timer)
        await work()
      })
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Another tab still has this room open. Wake or close it, then retry activation. Public routing remains held.')
      throw error
    } finally { clearTimeout(timer) }
  }
  #name(room: string): string {
    if (!/^[0-9a-f]{64}$/.test(room)) throw new Error('Invalid room closure scope.')
    return `kithmoot.room-public.${room}`
  }
  close(): void { navigator.serviceWorker?.removeEventListener('message', this.#workerReady); this.#channel.close(); this.#listeners.clear() }
}

/** A Web Lock cannot see tabs running an older build which predates the
 * gate. The controlling worker enumerates every same-app client, including
 * uncontrolled clients, and requires this build's gate acknowledgement.
 * Old/frozen/uncontrolled tabs cause refusal, never a timed-out success. */
async function checkRoomTabs(): Promise<void> {
  const worker = navigator.serviceWorker?.controller
  if (!worker) throw new Error('Reload KithMoot after its update finishes before activating a Bothy room.')
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel()
    const finish = (ok: boolean) => { clearTimeout(timer); channel.port1.close(); ok ? resolve() : reject(new Error('Update, wake or close the other KithMoot tabs before activating Bothy.')) }
    const timer = setTimeout(() => finish(false), 10_000)
    channel.port1.onmessage = event => finish(event.data === true)
    worker.postMessage('kithmoot:check-room-route-tabs-v1', [channel.port2])
  })
}
