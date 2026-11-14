/**
 * What to tell somebody whose room would not create, join or take a
 * message, when the failure came from a relay rather than from them.
 *
 * `relay-pool.ts` throws its own diagnosis - which relay, which of its own
 * words, whether a timeout or an outright rejection - because that
 * difference matters to whoever fixes a relay. It does not matter to
 * somebody trying to get back into a conversation, and reading it out
 * ("every relay rejected the event (wss://nos.lol/: connection failure:
 * websocket closed; …)") taught them nothing they could act on (M6). The
 * raw text still belongs in the console; this is
 * only ever what the room itself says.
 *
 * No DOM, so it can be tested without a browser.
 */

import { KithmootNodeError } from '../../src/kithmoot-node.js'

/** The known shapes a relay failure throws in, from `src/relay-pool.ts`. */
const RELAY_FAILURE = /every relay rejected the event|no relay could be reached in time/

function rawMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Whether this looks like the room simply could not reach a relay, rather
 *  than some other failure a generic apology has to cover instead. */
export function isNetworkFailure(err: unknown): boolean {
  return RELAY_FAILURE.test(rawMessage(err))
}

export const NETWORK_FAILURE_COPY = 'Could not reach the network. Check your connection and try again.'
export const GENERIC_FAILURE_COPY = 'Something went wrong. Try again.'
export const NODE_BUSY_COPY = 'Your node is busy. Try again in a minute.'
export const NODE_SILENT_COPY = 'Your node did not answer. Check it is running and try again.'
export const NODE_FULL_COPY = 'Your node is full. Close a room you no longer need, or raise its room limit, then try again.'

/** The node is holding as many rooms as it allows: waiting will not help. */
function nodeFull(err: unknown): boolean {
  return err instanceof KithmootNodeError && err.code === 'too-many-rooms'
}

/** A failure whose message was written for the person reading it, such as
 *  "Pair your node first", and so is shown as it stands. */
export class PersonError extends Error {}

/** Whether a node request may succeed if made again shortly: it was turned
 *  away for load (429, 5xx) or never answered. Refusals are not retried. */
export function isRetryableNodeFailure(err: unknown): boolean {
  return err instanceof KithmootNodeError && err.reason === 'unavailable' && !nodeFull(err)
}

/** Three tries in all. A node's request budget is a minute long, so a
 *  refusal for load waits longer than a request that went unanswered. */
export const NODE_CREATE_ATTEMPTS = 3
export function nodeCreateRetryDelay(err: unknown, attempt: number): number {
  const busy = err instanceof KithmootNodeError && err.status === 429
  return (busy ? 20000 : 3000) * attempt
}

/** What the sheet says while it waits to try again. */
export function nodeRetryCopy(err: unknown): string {
  const busy = err instanceof KithmootNodeError && (err.status === 429 || err.status >= 500)
  return busy ? 'Your node is busy. Trying again…' : 'Your node did not answer. Trying again…'
}

function nodeFailure(err: KithmootNodeError): string {
  if (nodeFull(err)) return NODE_FULL_COPY
  if (err.reason !== 'unavailable') return err.message
  return err.status === 429 || err.status >= 500 ? NODE_BUSY_COPY : NODE_SILENT_COPY
}

/** The plain-language line to show; the raw text, for whoever logs or
 *  copies it, is `rawMessage`d separately by the caller. */
export function describeFailure(err: unknown): string {
  if (err instanceof PersonError) return err.message
  if (err instanceof KithmootNodeError) return nodeFailure(err)
  return isNetworkFailure(err) ? NETWORK_FAILURE_COPY : GENERIC_FAILURE_COPY
}

/** A call on a node room that the node's call relay has no room for. Calls,
 *  not rooms, are what a node runs out of first: each person on a call holds
 *  relay ports for as long as they are on it. */
export const NODE_CALLS_FULL_COPY = "This node's calls are full. Try again when a call ends."

/** How long a call waits, with nobody reached, before the node's own word
 *  that it is full is taken as the reason. Under it, a call still setting up
 *  would flash the note. */
export const NODE_CALLS_FULL_GRACE_MS = 5000

export interface NodeCallFacts {
  /** How many others are on this call. */
  othersOnCall: number
  /** How many of them this device has a live connection to. */
  reached: number
  /** How many of them this device has not reached once since it joined. */
  neverReached: number
  /** The node's word, absent when it gives none (an older node). */
  nodeFull?: boolean
  /** The relay's last refusal of this device on this call: 486 or 508. */
  refusal?: number
  /** Since this device joined the call. */
  waitedMs: number
}

/**
 * Whether the call says the node's calls are full, rather than leaving
 * somebody in a call that never connects.
 *
 * - Reached everybody on the call: no. The call is working.
 * - A 486 or 508 from the relay: yes, unless the node says it is not full,
 *   in which case the 486 was this login's own share of the relay and the
 *   ordinary connection notices apply. An older node says nothing, and on
 *   a node that small the share and the limit are the same eight ports, so
 *   that refusal is read as full.
 * - No refusal of its own (the person already on the call, whose new
 *   partner was refused): yes once the node says full and the grace has
 *   passed with somebody on the call never reached. A partner who was
 *   reached and dropped is a network fault, not a full node: a small node
 *   is full whenever two calls run.
 * - Any other refusal code, 401 and 403 among them: never. Those are about
 *   access, not room.
 */
export function showNodeCallsFull(facts: NodeCallFacts): boolean {
  if (facts.othersOnCall < 1 || facts.reached >= facts.othersOnCall) return false
  if (facts.refusal === 486 || facts.refusal === 508) return facts.nodeFull !== false
  return facts.nodeFull === true && facts.neverReached > 0 && facts.waitedMs >= NODE_CALLS_FULL_GRACE_MS
}

/** Whether to refuse starting or joining a call before it opens: only when
 *  the node has just said full and this device holds no live connection
 *  that a call could use without a new relay port. */
export function refuseNodeCallStart(facts: { nodeFull?: boolean; connected: boolean }): boolean {
  return facts.nodeFull === true && !facts.connected
}
