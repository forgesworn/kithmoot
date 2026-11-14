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

/** A failure whose message was written for the person reading it, such as
 *  "Pair your node first", and so is shown as it stands. */
export class PersonError extends Error {}

/** Whether a node request may succeed if made again shortly: it was turned
 *  away for load (429, 5xx) or never answered. Refusals are not retried. */
export function isRetryableNodeFailure(err: unknown): boolean {
  return err instanceof KithmootNodeError && err.reason === 'unavailable'
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
