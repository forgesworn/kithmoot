import { protocolTask, type ProtocolExecution } from './protocol-execution.js'

interface Timer {
  due: number
  readonly interval?: number
  readonly effect: (execution: ProtocolExecution | undefined) => void | Promise<void>
  readonly rootStart?: (begin: (execution: ProtocolExecution) => boolean) => Promise<void>
  handle?: ReturnType<typeof setTimeout>
  serial: number
}

/** Local scheduling only. A fired callback registers its whole job before
 * entering the actual execution boundary. Suspension fences even callbacks
 * already queued by the runtime, while keeping their original deadlines. */
export class ProtocolTimers {
  readonly #execution: ProtocolExecution
  readonly #now: () => number
  readonly #timers = new Map<string, Timer>()
  readonly #unsubscribe?: () => void
  #suspended = false
  #closed = false
  constructor(execution: ProtocolExecution, now: () => number = Date.now) {
    this.#execution = execution; this.#now = now
    this.#unsubscribe = execution.onSuspend?.(suspended => {
      this.#suspended = suspended
      for (const [name, timer] of this.#timers) {
        timer.serial++; clearTimeout(timer.handle); timer.handle = undefined
        if (!suspended && !this.#closed) this.#arm(name, timer)
      }
    })
  }
  has(name: string): boolean { return this.#timers.has(name) }
  schedule(name: string, delay: number, effect: Timer['effect'], interval?: number): void {
    if (this.#closed) return
    if (!Number.isFinite(delay) || delay < 0 || interval !== undefined && (!Number.isFinite(interval) || interval <= 0)) throw new Error('invalid protocol timer')
    this.cancel(name)
    const timer: Timer = { due: this.#now() + delay, effect, ...(interval === undefined ? {} : { interval }), serial: 0 }
    this.#timers.set(name, timer)
    if (!this.#suspended) this.#arm(name, timer)
  }
  /** A lifecycle root must not sit beneath a timer job which awaits it.
   * start registers the root synchronously and returns that exact promise.
   * begin is called in its genuine native start callback, before suspension. */
  scheduleRoot(name: string, delay: number, start: NonNullable<Timer['rootStart']>): void {
    if (this.#closed) return
    if (!this.#execution.retainRoot || !Number.isFinite(delay) || delay < 0) throw new Error('invalid lifecycle root timer')
    this.cancel(name)
    const timer: Timer = { due: this.#now() + delay, effect: () => {}, rootStart: start, serial: 0 }
    this.#timers.set(name, timer)
    if (!this.#suspended) this.#arm(name, timer)
  }
  cancel(name: string): void {
    const timer = this.#timers.get(name)
    if (!timer) return
    timer.serial++; clearTimeout(timer.handle); this.#timers.delete(name)
  }
  #arm(name: string, timer: Timer): void {
    const serial = timer.serial
    const current = () => !this.#closed && !this.#suspended && timer.serial === serial && this.#timers.get(name) === timer
    timer.handle = setTimeout(() => {
      if (!current()) return
      timer.handle = undefined
      if (timer.rootStart) {
        try {
          const pending = timer.rootStart(execution => {
            execution.check('lifecycle-timer-start')
            if (!current()) return false
            this.#timers.delete(name); return true
          })
          this.#execution.retainRoot!(pending)
          void pending.catch(() => { /* The lifecycle owner handles refusal. */ })
        } catch { /* Invalid root ownership closes the embedding. */ }
        return
      }
      // task() registers synchronously, including while its native selector
      // is queued. Recheck the fence inside that genuine boundary as well.
      void protocolTask(this.#execution, 'timer-' + name, async execution => {
        if (!current()) return
        execution?.check('timer-' + name)
        if (timer.interval === undefined) this.#timers.delete(name)
        else {
          // Missed ticks coalesce; neither a pause nor a late tick moves the
          // cadence's original origin or any credential/authority deadline.
          const at = this.#now()
          timer.due += Math.max(1, Math.floor((at - timer.due) / timer.interval) + 1) * timer.interval
          this.#arm(name, timer)
        }
        await timer.effect(execution)
      }).catch(() => { /* Execution failures are handled by its owner. */ })
    }, Math.max(0, timer.due - this.#now()))
    ;(timer.handle as unknown as { unref?: () => void }).unref?.()
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true; this.#unsubscribe?.()
    for (const name of this.#timers.keys()) this.cancel(name)
  }
}
