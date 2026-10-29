import { spryEndpoint } from './spry.js'

/**
 * The outside test of a member's built-in call relay (docs/protocol.md,
 * "Relay outside test"; docs/design/2026-10-28-built-in-relay.md, 2.5).
 *
 * A relay's host asks one other device in the room, by name, to test the
 * host's relay from wherever that device is. The tester runs two temporary
 * peers of its own: A, relay-only on the host's relay, and B, with no TURN,
 * using the relay's listener as its STUN server. B's checks reach A's relayed
 * address from B's own public address, so the host's allocation port as well
 * as its listener is proved reachable from outside, which a test with both
 * peers on the relay cannot show.
 *
 * Both messages ride the room's existing call signalling envelope (a signal
 * wrap to exactly one device, signed by the sending device key, NIP-44, with
 * a NIP-40 expiration a minute out): a request from the host and a result
 * back to the host alone. Neither carries an address, a credential or a
 * name; the result is pass or fail, which part failed, whether the tester
 * was on the host's own network, and the signed time.
 */

/** The parts a failed test names, in the order the test reaches them.
 *  `declined`: the tester did not run it (already testing, asked again too
 *  soon, or not allowed to use this host's relay). `credentials`: the host's
 *  node gave the tester no relay login. `allocate`: the tester got no relayed
 *  address from the listener. `stun`: the listener did not answer the tester's
 *  plain STUN request. `inbound`: both ends were ready, but nothing reached
 *  the relayed address from outside. */
export const RELAY_TEST_STAGES = ['declined', 'credentials', 'allocate', 'stun', 'inbound'] as const
export type RelayTestStage = typeof RELAY_TEST_STAGES[number]

/** A host asking one device to test the relay the host shares in this room. */
export interface RelayTestRequest {
  /** 16 lower-case hex, fresh per request. The result echoes it. */
  id: string
  /** The host's `spry:` endpoint exactly as its room offer carries it. */
  endpoint: string
}

/** What the tester tells the host, and nobody else. */
export interface RelayTestResult {
  id: string
  endpoint: string
  /** True only when data went through the relayed address from outside. */
  ok: boolean
  /** On a failure only: which part failed. */
  stage?: RelayTestStage
  /** Present, and exactly `true`, when the tester's public address is the
   *  relay's own: the test ran from the host's network (a hairpin), so a
   *  pass is a hint, never "reachable". */
  sameNetwork?: true
}

/** How long a host waits for a result before it says nobody answered:
 *  a fresh credential over `spry:` control plus the test itself. */
export const RELAY_TEST_ANSWER_MS = 45_000
/** The tester's own limit on one run, from creating the peers to the verdict. */
export const RELAY_TEST_RUN_MS = 15_000
/** A tester runs at most one test per asking device in this many milliseconds. */
export const RELAY_TEST_COOLDOWN_MS = 60_000
/** Relay-test signals admitted per sending device per 20-second window,
 *  apart from the call's own signalling budget. */
export const RELAY_TEST_SIGNALS_PER_WINDOW = 8
/** The longest endpoint a relay-test message may name. */
export const MAX_RELAY_TEST_ENDPOINT_LENGTH = 1024

const ID = /^[0-9a-f]{16}$/

function exactKeys(value: object, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.every(key => allowed.includes(key)) && required.every(key => keys.includes(key))
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_RELAY_TEST_ENDPOINT_LENGTH || !value.startsWith('spry:')) return false
  try { return spryEndpoint(value) === value } catch { return false }
}

/** A request: exactly `id` and `endpoint`, nothing else. */
export function validRelayTestRequest(value: unknown): value is RelayTestRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  return exactKeys(request, ['id', 'endpoint'], ['id', 'endpoint']) &&
    typeof request.id === 'string' && ID.test(request.id) && validEndpoint(request.endpoint)
}

/**
 * A result: `id`, `endpoint` and `ok`; `stage` exactly when `ok` is false;
 * `sameNetwork` only as `true`, and only from a test that ran (never with
 * `declined` or `credentials`). Anything else, including an unknown key,
 * refuses the whole signal.
 */
export function validRelayTestResult(value: unknown): value is RelayTestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (!exactKeys(result, ['id', 'endpoint', 'ok', 'stage', 'sameNetwork'], ['id', 'endpoint', 'ok'])) return false
  if (typeof result.id !== 'string' || !ID.test(result.id) || !validEndpoint(result.endpoint) || typeof result.ok !== 'boolean') return false
  if (result.ok ? result.stage !== undefined : !RELAY_TEST_STAGES.includes(result.stage as RelayTestStage)) return false
  if (result.sameNetwork !== undefined && (result.sameNetwork !== true || result.stage === 'declined' || result.stage === 'credentials')) return false
  return true
}

/** What the tester saw, gathered from its two peers. Addresses stay on the
 *  tester: only the verdict leaves it. */
export interface RelayTestObservations {
  /** The relay's IPv4 literal, from the TURN URLs the node returned. */
  turnHost: string
  /** Peer A gathered a relayed candidate. */
  relayed: boolean
  /** Addresses of peer B's server-reflexive candidates. */
  reflexive: readonly string[]
  /** Addresses of peer B's host candidates (an mDNS name never matches). */
  hosts: readonly string[]
  /** Address of peer B's local candidate on its selected pair, when known. */
  local?: string
  /** The data-channel echo came back. */
  echoed: boolean
  /** Peer A's nominated, succeeded pair has a `relay` local candidate and
   *  received bytes. */
  pathA: boolean
  /** Peer B's nominated, succeeded pair has a local candidate that is not
   *  `relay` and received bytes. */
  pathB: boolean
}

export interface RelayTestVerdict { ok: boolean; stage?: RelayTestStage; sameNetwork?: true }

/**
 * The verdict a tester sends. `sameNetwork` when any of B's reflexive or
 * host addresses, or B's selected local address, is the relay's own address:
 * B then reached the relay from inside the host's network (or the host's own
 * machine), which proves nothing about outside. A relay with mapped ports
 * refuses peers on its own addresses, so such a test usually fails
 * `inbound`. A pass needs the echo and both paths. A failure names the first
 * part that did not work: no relayed address, then (when B learnt no outside
 * address and is not on the relay's network) no STUN answer, otherwise
 * inbound.
 */
export function relayTestVerdict(seen: RelayTestObservations): RelayTestVerdict {
  const sameNetwork = seen.reflexive.includes(seen.turnHost) || seen.hosts.includes(seen.turnHost) || seen.local === seen.turnHost
  const verdict: RelayTestVerdict = seen.echoed && seen.pathA && seen.pathB ? { ok: true }
    : !seen.relayed ? { ok: false, stage: 'allocate' }
      : seen.reflexive.length === 0 && !sameNetwork ? { ok: false, stage: 'stun' }
        : { ok: false, stage: 'inbound' }
  return sameNetwork ? { ...verdict, sameNetwork: true } : verdict
}

/** What a host may say about its relay from one result: `reachable` only for
 *  a pass from another network; a pass from its own network is a hint. */
export function relayTestFinding(result: Pick<RelayTestResult, 'ok' | 'stage' | 'sameNetwork'>): 'reachable' | 'same-network' | 'unreachable' | 'not-run' {
  if (result.stage === 'declined' || result.stage === 'credentials') return 'not-run'
  if (result.sameNetwork) return 'same-network'
  return result.ok ? 'reachable' : 'unreachable'
}
