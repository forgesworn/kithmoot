/**
 * A remote signer that did not answer in time.
 *
 * Joining as an account held in a NIP-46 bunker costs one signature, the
 * device's credential for the room, and the bunker has fifteen seconds to
 * give it. `signet-login` reports a request that gets no answer as
 * `nip46-<method>-timeout`. That is not the room refusing and not a relay
 * refusing (a relay that will not take the request is `-publish-failed`):
 * it is a signer that is asleep, closed, or waiting for its owner to say
 * yes. So the person is told to go and look at their signer, and the join
 * is tried once more on its own while they do.
 */
export function isSignerTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\bnip46-[a-z0-9_]+-timeout\b/.test(message)
}

export const SIGNER_WAITING = 'Waiting for your signer… Open your signer app and approve the request.'
export const SIGNER_SILENT = 'Your signer did not answer. Open your signer app, approve any waiting request, then join again.'
