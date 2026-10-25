import type { BoxTraceEvent, BoxTraceObserver } from './mls-box-client.js'
const enabled = () => import.meta.env.DEV && import.meta.env.VITE_MIXED_INVITATION_LAB === 'true'
const phases = new Set(['request-start','sign-start','consent-start','consent-end','sign-complete','sign-refused','accept-refused','transport-start','transport-end','transport-refused','node-refused','parse-start','parse-end','timeout','inactive','caller-return','caller-finally','work-settled','invalidate','settled-start','settled-end'])
const results = new Set(['ok','refused','not-signed','unavailable','malformed','unsupported','unauthorised','expired','revoked','denied','busy','stale','replay','restore-fenced','witness-pending','node-authentication','node-replay','node-authority','node-expired','node-other'])
let events: (BoxTraceEvent & { client: number })[] = [], clients = 0, overflow = false
export function startBoxLabTrace() { if (!enabled()) throw new Error('Explicit development lab required'); events = []; clients = 0; overflow = false; return { started: true } }
export function readBoxLabTrace() { if (!enabled()) throw new Error('Explicit development lab required'); return { events: events.map(e => ({ ...e })), overflow } }
export function boxLabTraceObserver(): BoxTraceObserver | undefined {
  if (!enabled()) return undefined
  const client = ++clients
  return event => { if (!Number.isSafeInteger(event.request) || event.request < 0 || !Number.isSafeInteger(event.elapsedMs) || event.elapsedMs < 0 || !phases.has(event.phase) || event.result !== undefined && !results.has(event.result)) return; if (events.length >= 256) { overflow = true; return } events.push({ client, request: event.request, phase: event.phase, elapsedMs: event.elapsedMs, ...(event.result ? { result: event.result } : {}) }) }
}
