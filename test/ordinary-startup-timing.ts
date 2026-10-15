import { performance } from 'node:perf_hooks'
import type { Page } from '@playwright/test'
const starts = new WeakMap<Page, number>()
export function startupTimingEnabled(priorLease: boolean): boolean { return priorLease && process.env.ORDINARY_STARTUP_TIMING === '1' }
/** Test-only measurements. The normal acceptance path returns the exact
 * original promise; the separately labelled diagnostic opts into snapshots. */
export function measureStartupStage<T>(page: Page, stage: string, work: () => Promise<T>, priorLease: boolean): Promise<T> {
  if (!startupTimingEnabled(priorLease)) return work()
  const beginning = performance.now(), origin = starts.get(page) ?? beginning
  starts.set(page, origin)
  const emit = (event: string, facts: unknown = undefined) => console.log('startup timing', JSON.stringify({ stage, event, elapsedMs: Math.round(performance.now() - origin), stageMs: Math.round(performance.now() - beginning), facts }))
  emit('begin')
  return (async () => {
    let outcome = 'failed'
    try { const value = await work(); outcome = 'complete'; return value }
    finally {
      let facts: unknown
      try {
        facts = await page.evaluate(async () => {
          const w = window as any
          return { dials: w.dials?.length, frames: w.frames?.length, sockets: w.sockets?.map((s: WebSocket) => s.readyState),
            phase: typeof w.preparedPhase === 'function' ? await w.preparedPhase() : w.actualStage,
            signCalls: w.signCalls, entropy: w.entropy, puts: w.puts,
            memberOpen: w.memberOpenStatus, memberJoin: w.memberJoinStatus, memberSend: w.memberSendStatus, memberClose: w.memberCloseStatus }
        })
      } catch (error) { facts = { unavailable: (error as Error).message } }
      emit(outcome, facts)
    }
  })()
}
