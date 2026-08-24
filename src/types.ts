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
}
