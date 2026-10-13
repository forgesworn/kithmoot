import type { BoardContextCustody } from './board-context-custody.js'

/** Serialises awaited context work for one captured view. A late factory or
 * result cannot revive an aborted view; close joins even late-open custody. */
export class BoardContextView {
  readonly ready: Promise<BoardContextCustody>
  #custody?: BoardContextCustody
  #closed = false
  #pending = 0
  #tail: Promise<unknown> = Promise.resolve()
  constructor(readonly current: () => boolean, open: () => Promise<BoardContextCustody>) {
    this.ready = Promise.resolve().then(() => { this.check(); return open() }).then(custody => {
      this.#custody = custody
      try { this.check() } catch { custody.revoke(); throw new Error('The board view closed before its context opened.') }
      return custody
    })
    void this.ready.catch(() => {})
  }
  check(): void { if (this.#closed) throw new Error('The board view is no longer current.'); const valid=this.current(); if (this.#closed || !valid) throw new Error('The board view is no longer current.') }
  run<T>(work: (custody: BoardContextCustody) => Promise<T>): Promise<T> {
    try { this.check() } catch (error) { return Promise.reject(error) }
    this.#pending++
    const pending = this.#tail.then(async () => {
      this.check(); const custody = await this.ready; this.check()
      const value = await work(custody); this.check(); return value
    }).finally(() => { this.#pending-- })
    this.#tail = pending.catch(() => {})
    return pending
  }
  get pending(): boolean { return this.#pending !== 0 }
  revoke(): void { this.#closed = true; this.#custody?.revoke() }
  async close(): Promise<void> {
    this.revoke(); await Promise.allSettled([this.ready,this.#tail]); await this.#custody?.close()
  }
}
