// Every fixed input the vectors are built from, in one place, so a value is
// never typed twice and never drifts between `generate.mjs` and
// `verify.test.ts`. Nothing here is random: every key, secret and timestamp
// is either a literal or derived from a fixed label via `determinism.mjs`.

import { getPublicKey } from 'nostr-tools/pure'
import { deriveSecretKey, seed32 } from './determinism.mjs'

export const BASE_URL = 'https://kithmoot.com/j'

// --- Timestamps (all Unix seconds) ------------------------------------
// Reused across groups so the vectors read as one coherent scenario rather
// than unrelated fixtures, and so a reader can sanity-check "expiresAt is
// after createdAt" at a glance.
export const NOW = 1_800_000_000
export const CREDENTIAL_CREATED_AT = 1_799_990_000
export const CREDENTIAL_EXPIRES_AT = NOW + 3600
export const CREDENTIAL_EXPIRES_AT_EXPIRED = NOW - 3600
export const SIGNAL_CREATED_AT = 1_799_995_000
export const KINDRED_EXPIRES_AT = NOW + 3600

// --- Room secrets --------------------------------------------------------
// Two edge cases (all-zero, all-0xff) plus two "typical" secrets used
// throughout the rest of the vectors so a credential/roster/signal fixture
// can be traced back to a specific, independently checkable room.
export const ROOM_SECRET_ZERO = new Uint8Array(32)
export const ROOM_SECRET_FF = new Uint8Array(32).fill(0xff)
export const ROOM_SECRET_1 = seed32('room-secret-1')
export const ROOM_SECRET_2 = seed32('room-secret-2')

// --- Identities ------------------------------------------------------
// secp256k1 keypairs derived from fixed labels - see `deriveSecretKey`.
export const PARTICIPANT_A_SK = deriveSecretKey('participant-a')
export const PARTICIPANT_A = getPublicKey(PARTICIPANT_A_SK)

export const DEVICE_A_SK = deriveSecretKey('device-a')
export const DEVICE_A = getPublicKey(DEVICE_A_SK)

/** Signs a roster event for an entry that names DEVICE_A - i.e. a device
 *  other than the one the credential authorises. */
export const DEVICE_IMPOSTOR_SK = deriveSecretKey('device-impostor')
export const DEVICE_IMPOSTOR = getPublicKey(DEVICE_IMPOSTOR_SK)

/** A room host trusted by the `kith`-gated policy fixtures. */
export const HOST_SK = deriveSecretKey('host-issuer-a')
export const HOST = getPublicKey(HOST_SK)

/** A second, genuine issuer who is simply not on any policy's allow-list. */
export const HOST_UNTRUSTED_SK = deriveSecretKey('host-issuer-untrusted')
export const HOST_UNTRUSTED = getPublicKey(HOST_UNTRUSTED_SK)

/** The guest whose admission the kindred proofs vouch for. */
export const GUEST_SK = deriveSecretKey('kindred-guest')
export const GUEST = getPublicKey(GUEST_SK)

export const SENDER_SK = deriveSecretKey('signal-sender')
export const SENDER = getPublicKey(SENDER_SK)

export const RECIPIENT_SK = deriveSecretKey('signal-recipient')
export const RECIPIENT = getPublicKey(RECIPIENT_SK)

/** Holds a real keypair but is never the addressee of any wrap - stands in
 *  for a relay operator or a third member of the room trying to open a
 *  signal that was not sent to them. */
export const EAVESDROPPER_SK = deriveSecretKey('signal-eavesdropper')

export const EPHEMERAL_SK_OFFER = deriveSecretKey('signal-ephemeral-offer')
export const EPHEMERAL_SK_ICE = deriveSecretKey('signal-ephemeral-ice')

// --- Signalling payloads --------------------------------------------
export const SDP_FIXTURE =
  'v=0\r\no=- 1 1 IN IP4 192.168.1.42\r\na=candidate:1 1 udp 2130706431 192.168.1.42 54321 typ host'
export const ICE_FIXTURE = 'candidate:1 1 udp 1 10.0.0.1 1 typ host'
