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
 * A signed claim that `issuer` recognises `participant` at `tier`, until
 * `expiresAt`. Never issued for `open`, since open needs no proof.
 */
export type KindredProof = {
  tier: Exclude<AccessTier, 'open'>
  participant: string
  issuer: string
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
  /** Tracks this device is publishing. */
  tracks: TrackAdvert[]
  /** Singular roles this device is claiming, with the time of the claim. */
  claims: Partial<Record<SingularRole, number>>
  /** Unix seconds; used for staleness. */
  updatedAt: number
  /** True when this entry was published in answer to another device's
   *  arrival rather than as an arrival of its own. An answer never provokes
   *  another answer, which is what stops the room talking to itself for
   *  ever. Absent on a first announcement. */
  reply?: boolean
}
