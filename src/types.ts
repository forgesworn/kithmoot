import type { Event } from 'nostr-tools/pure'

/** A device credential is an ordinary signed Nostr event, never published bare. */
export type DeviceCredential = Event

/** What a device may do with a track. */
export type TrackRole = 'camera' | 'mic' | 'screen' | 'screen-audio'

/** Roles that are singular per participant, because two of them break the call. */
export type SingularRole = 'mic' | 'monitor'

export interface TrackAdvert {
  trackId: string
  role: TrackRole
}

/** Kindred tiers, closest first: family, mutual verified bond, one-way
 *  recognition, no requirement at all. */
export type AccessTier = 'open' | 'ken' | 'kith' | 'kin'

/** A room's admission rule. `admitted` lists the issuer pubkeys the room
 *  trusts to vouch for guests; irrelevant when `tier` is `open`. */
export interface RoomPolicy {
  tier: AccessTier
  admitted?: string[]
}

/**
 * A signed claim that `issuer` recognises `participant` at `tier` in `room`,
 * until `expiresAt`. Never issued for `open`, since open needs no proof.
 *
 * `room` is what stops a proof being a bearer token: without it, one proof
 * admits its holder to every room that happens to trust the same issuer, and
 * an issuer who vouched for a guest at one moot has not vouched for them at
 * all of them. The cost of that binding is stated plainly: a kindred proof is
 * a room grant here, not a portable statement about a relationship, so an
 * issuer mints one per room. In this protocol the party who vouches is the
 * party who sent the join link, so it already knows the room id.
 */
export type KindredProof = {
  tier: Exclude<AccessTier, 'open'>
  participant: string
  issuer: string
  /** The room id this proof is valid in. */
  room: string
  /** 32 random bytes, hex, unique to this proof. Signed over, so two proofs
   *  on identical terms are still distinguishable - which is what a revocation
   *  list, or an audit, needs to name one of them. */
  nonce: string
  sig: string
  expiresAt: number
}

export interface RosterEntry {
  /** The person. */
  participant: string
  /** This endpoint. */
  device: string
  /** Proof that `device` speaks for `participant` in this room. */
  credential: DeviceCredential
  /** This participant's kindred proof, so every other member can evaluate
   *  their tier for itself rather than trusting them to have self-checked.
   *  Inside the room-key ciphertext, so relays never see it. Absent in an
   *  open room, where there is nothing to prove. */
  proof?: KindredProof
  /** Tracks this device is publishing. */
  tracks: TrackAdvert[]
  /** Singular roles this device is claiming, with the time of the claim. */
  claims: Partial<Record<SingularRole, number>>
  /** Unix seconds; used for staleness. */
  updatedAt: number
  /** True when this entry is not an arrival: an answer to somebody else's
   *  arrival, or the empty entry a device publishes as it leaves. Neither
   *  provokes an answer, which is what stops the room talking to itself for
   *  ever. Absent on a first announcement. */
  reply?: boolean
}

/**
 * A forwarder the room may promote to when the mesh outgrows the uplink.
 *
 * `url` is the signalling endpoint - a `ws:`/`wss:` address the client
 * connects to. `pubkey` is the forwarder's own Nostr key, when it has one,
 * so a client can name a preference that survives the operator moving the
 * host. `label` is for people, never for logic.
 *
 * Note what is NOT here, and cannot be: the room key. A forwarder is given
 * the room *id* and nothing else, so it routes ciphertext it can neither
 * read nor forge attribution for. `decodeDescriptorEvent` projects every
 * entry onto exactly these three fields for that reason - see
 * `descriptor.ts`.
 */
export interface ForwarderRef {
  url: string
  pubkey?: string
  label?: string
}

/**
 * An ICE server offered to every member of the room.
 *
 * Shaped to drop straight into an `RTCPeerConnection`'s `iceServers`.
 * `username`/`credential` are optional and normally absent: TURN credentials
 * are minted per viewer with a TTL (see `turn.ts`), and a single shared pair
 * sitting in a descriptor is exactly the static secret that minting exists to
 * avoid. They are here only for a self-hosted TURN with a static password,
 * and that is a downgrade, stated plainly.
 */
export interface IceServerRef {
  urls: string[]
  username?: string
  credential?: string
}
