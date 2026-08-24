/**
 * Provisional event kinds. These are NOT allocated and will change when the
 * KithMoot spec is written. Deliberately clear of 24170/24171 (RelaySwarm)
 * and 25050-25055 (NIP-AC).
 */
export const KINDS = {
  /** Device credential. Signed by the participant key; never published to a
   *  relay - it travels inside the encrypted roster, so relays never see the
   *  participant pubkey. */
  CREDENTIAL: 20460,
  /** Roster / presence, encrypted to the room key and published once. */
  ROSTER: 20461,
  /** Ephemeral gift wrap carrying SDP and ICE. Reused from NIP-AC deliberately. */
  SIGNAL_WRAP: 21059,
  /** Inner signalling event, wrapped in SIGNAL_WRAP. Never published bare. */
  SIGNAL: 20462,
} as const
