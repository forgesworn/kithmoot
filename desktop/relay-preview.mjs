/**
 * Preview switches for the built-in call relay's page: a development run
 * names a state of the page and the main process reports it, so the owner can
 * see every state without a hot router or a carrier-grade NAT.
 *
 * KITHMOOT_DESKTOP_RELAY_PREVIEW=<state id>[:<reason>]   e.g. S5 or S7:double-nat
 * KITHMOOT_DESKTOP_RELAY_PREVIEW_CHECK=<outcome>         reachable, same-network,
 *                                                        inbound, allocate, declined,
 *                                                        credentials, noanswer
 *
 * Read only from an unpackaged run (`packaged: false`); a packaged build never
 * looks at them. Start and Stop are logged and ignored: nothing is run.
 */

const LIMIT = 5_000_000_000
const base = { available: true, blocked: false, wanted: false, startOnOpen: false, today: 0, dailyLimit: LIMIT }
const running = { wanted: true, status: 'running', control: { relays: 2 }, counts: { allocations: 0, bytesRelayed: 0, lastAllocation: null },
  mapping: { method: 'upnp', allocationPorts: 10, requested: 10, permanent: false, restored: 0 } }
const failed = (code, wanted = false, extra = {}) => ({ wanted, status: 'failed', error: { code, message: 'Preview' }, ...extra })

/** The state each id reports. `reason` is used by S7 and S7x only. */
const STATES = Object.freeze({
  S1: () => ({ status: 'off' }),
  S13: () => ({ status: 'off', startOnOpen: true }),
  S3: () => ({ wanted: true, status: 'starting' }),
  S4: () => ({ ...running }),
  S5: () => ({ ...running, today: 1_200_000_000, counts: { allocations: 3, bytesRelayed: 1_200_000_000, lastAllocation: null } }),
  S14: () => ({ ...running, control: { relays: 0 } }),
  S11: () => ({ wanted: true, status: 'off' }),
  S7: reason => ({ wanted: true, status: 'cannot-host', reason }),
  S7x: reason => ({ status: 'cannot-host', reason }),
  S8a: () => failed('ERR_RELAY_EXITED', true),
  S8b: () => failed('ERR_CRASHED_TWICE'),
  S8c: () => failed('ERR_START_FAILED'),
  S8d: () => failed('ERR_HELPER'),
  S8e: () => failed('ERR_STOP_TIMEOUT'),
  S8f: () => failed('ERR_RELAY_EXITED'),
  S8g: () => failed('ERR_PREVIEW_OTHER'),
  S8h: () => failed('ERR_IDENTITY'),
  S9: () => failed('ERR_DAILY_LIMIT', true, { today: LIMIT }),
  S10a: () => failed('ERR_HAND_PAIRED'),
  S10b: () => failed('ERR_NO_ACCOUNT'),
  S10c: () => failed('ERR_OTHER_ACCOUNT'),
  S10d: () => failed('ERR_NO_CONTROL_RELAYS'),
  S12: () => ({ wanted: true, status: 'stopping' }),
})
export const PREVIEW_IDS = Object.freeze(Object.keys(STATES))
const CHECKS = Object.freeze(['reachable', 'same-network', 'inbound', 'allocate', 'declined', 'credentials', 'noanswer'])

/** `{ id, reason }` for a switch such as "S7:double-nat", or undefined if it names nothing. */
export function parsePreview(value) {
  if (typeof value !== 'string') return undefined
  const [id, reason = 'carrier-grade-nat', ...rest] = value.trim().split(':')
  if (rest.length || !Object.hasOwn(STATES, id) || !/^[a-z-]{1,32}$/.test(reason)) return undefined
  return { id, reason }
}

/** The preview the environment asks for, never in a packaged build. */
export function previewFromEnvironment({ env, packaged }) {
  if (packaged === true) return undefined
  const spec = parsePreview(env?.KITHMOOT_DESKTOP_RELAY_PREVIEW)
  if (!spec) return undefined
  const check = CHECKS.includes(env.KITHMOOT_DESKTOP_RELAY_PREVIEW_CHECK) ? env.KITHMOOT_DESKTOP_RELAY_PREVIEW_CHECK : undefined
  return { ...spec, check }
}

/** The relay host's surface, reporting one canned state and running nothing. */
export function createPreviewRelayHost({ id, reason, check, changed = () => {}, log = () => {} }) {
  let startOnOpen
  const state = () => {
    const canned = STATES[id](reason)
    return { ...base, ...canned, startOnOpen: startOnOpen ?? canned.startOnOpen ?? false, ...(check ? { preview: { check } } : {}) }
  }
  return {
    state,
    pairing: () => undefined,
    setContext() {},
    async setStartOnOpen(on) { startOnOpen = on === true; log('Preview: start on open', startOnOpen); changed(state()) },
    async start() { log('Preview: start ignored'); return undefined },
    async stop() { log('Preview: stop ignored'); return true },
    async resume() { return true },
    async removeKeys() { log('Preview: remove keys ignored'); return false },
    reopen() {},
  }
}
