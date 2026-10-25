import type { BoxTraceEvent, BoxTraceObserver } from './mls-box-client.js'
const enabled = () => import.meta.env.DEV && import.meta.env.VITE_MIXED_INVITATION_LAB === 'true'
let events: (BoxTraceEvent & { client: number })[] = [], clients = 0, overflow = false
export function startBoxLabTrace() { if (!enabled()) throw new Error('Explicit development lab required'); events = []; clients = 0; overflow = false; return { started: true } }
export function readBoxLabTrace() { if (!enabled()) throw new Error('Explicit development lab required'); return { events: events.map(e => ({ ...e })), overflow } }
export function boxLabTraceObserver(): BoxTraceObserver | undefined {
  if (!enabled()) return undefined
  const client = ++clients
  return event => { if (events.length >= 256) { overflow = true; return } events.push({ client, request: event.request, phase: event.phase, elapsedMs: event.elapsedMs, ...(event.result ? { result: event.result } : {}) }) }
}
