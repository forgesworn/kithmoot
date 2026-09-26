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
 * raw text still belongs in the console and in "Copy a bug report"; this is
 * only ever what the room itself says.
 *
 * No DOM, so it can be tested without a browser.
 */

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
export const GENERIC_FAILURE_COPY = 'Something went wrong. Try again, or copy a bug report from Room details.'

/** The plain-language line to show; the raw text, for whoever logs or
 *  copies it, is `rawMessage`d separately by the caller. */
export function describeFailure(err: unknown): string {
  return isNetworkFailure(err) ? NETWORK_FAILURE_COPY : GENERIC_FAILURE_COPY
}
