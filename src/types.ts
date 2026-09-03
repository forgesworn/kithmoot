import type { Event } from 'nostr-tools/pure'
import type { Reachability } from './reachability.js'

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

/** What a room requires of its agents. `owned-by-members`: an agent is
 *  admitted to the roster only with a verified ownership proof from a
 *  participant who is in the room. See `AgentOwnership`. */
export type AgentRule = 'owned-by-members'

/** A room's admission rule. `admitted` lists the issuer pubkeys the room
 *  trusts to vouch for guests; irrelevant when `tier` is `open`. `agents`
 *  is a separate rule about what an agent has to show; absent means
 *  nothing, which is how every room worked before it existed. */
export interface RoomPolicy {
  tier: AccessTier
  admitted?: string[]
  agents?: AgentRule
}

/**
 * A principal's signed statement that an agent is theirs.
 *
 * Signed by the principal over the agent's key, its own, when it was
 * issued, until when, and what the principal calls the agent. Room
 * independent: it is a fact about two keys, attested once and carried into
 * every room. What a client shows as "agent of" comes only from a proof it
 * verified itself; the codecs drop one that fails before anybody sees it.
 * See `ownership.ts`.
 */
export interface AgentOwnership {
  /** The agent's participant pubkey. */
  agent: string
  /** Who it acts for. */
  principal: string
  /** Unix seconds. */
  issuedAt: number
  /** Unix seconds. Absent means it stands until the keys change. */
  expiresAt?: number
  /** What the principal calls the agent, sanitised like a display name. */
  label?: string
  /** Schnorr by the principal. */
  sig: string
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

/**
 * A local, measured view of what this device is being asked to send.
 *
 * `peers` is the number of OTHER devices being sent to, so mesh cost is
 * `peers x perPeerBps` directly - the `(N-1)` is already applied by the
 * caller counting the room minus itself.
 *
 * This rides the wire inside an `AssistOffer`, which is why it lives here
 * rather than in `forwarder.ts` where it is used. Putting the estimate on the
 * wire rather than a derived "spare bandwidth" figure is deliberate: every
 * client then computes spare capacity with the same function from the same
 * numbers, so a deterministic selection stays deterministic even when two
 * clients disagree about what headroom to leave.
 */
export interface CapacityEstimate {
  /** Measured upload capacity, bits per second. */
  uplinkBps: number
  /** How many other devices this one is sending to. */
  peers: number
  /** Measured or configured send bitrate per peer, bits per second. */
  perPeerBps: number
}

/**
 * An offer to carry other people's media.
 *
 * This is what turns the room from something we host into something the
 * people in it host. A member that is publicly reachable can absorb the pairs
 * who cannot reach each other, using plain WebRTC and nobody's TURN server -
 * and unlike a fixed relay, there are more of these the more people arrive.
 *
 * **It is a claim, exactly as a display name is.** Nothing here is checked,
 * and nothing here can be: a device can advertise a gigabit uplink it does
 * not have, or `public` reachability from behind a NAT. The mitigation is not
 * a trust system, it is that a relay which cannot do the job shows up as a
 * connection that will not come up, and gets replaced - see
 * `selectAssistant`'s `exclude`. What a lie can cost is one failed attempt
 * and a fallback, which is the same thing an honest volunteer closing their
 * laptop costs.
 *
 * Note what a volunteer is not: it is not a forwarder. A forwarder is given
 * the room id and never the room key, so it cannot read what it carries. A
 * volunteer is a member of the room and holds the key - and has to be
 * directly connected to both ends of a pair to carry them, which is how it
 * receives their media as an ordinary participant anyway. **Relaying gives it
 * nothing it did not already have.** What it still cannot do is present one
 * member's media as another's, because `deriveMediaKey(roomKey, sender)`
 * binds a frame to whoever sent it. See `peer-relay.ts`.
 */
export interface AssistOffer {
  /**
   * How reachable this device measured itself to be - see
   * `classifyReachability`. Only `public` is any use as a relay, and it is
   * carried rather than assumed so a reader can see why a device was passed
   * over.
   */
  reachability: Reachability
  /** What this device's uplink is, and what it is already spending on its
   *  own call. Spare capacity is derived from this by every client
   *  identically - see `spareUplinkBps`. */
  capacity: CapacityEstimate
  /** How many pairs it is already relaying for. */
  relaying: number
  /** The most pairs it is willing to relay for, whatever its spare uplink
   *  works out to. Clamped to `MAX_ASSISTED_PAIRS` on the way in, so a device
   *  cannot volunteer itself into carrying the whole room. */
  maxRelayed: number
}

export interface RosterEntry {
  /** The person. */
  participant: string
  /**
   * What this person would like to be called.
   *
   * Self-asserted, always: anybody can type anything, and nothing here or
   * anywhere else checks it. It is a label on a pubkey, never a substitute
   * for one - `sanitiseDisplayName` bounds what it can look like, and every
   * renderer is required to show a short pubkey beside it so two people
   * called "Robin" stay apart and an impersonation is visible.
   *
   * Absent when nobody typed one, which keeps the wire byte-identical for
   * anyone who does not use this at all.
   */
  name?: string
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
  /**
   * This device's offer to relay for others, when it is making one.
   *
   * Absent whenever it is not, which is the default and which keeps the wire
   * byte-identical for a client that does not implement peer assist at all.
   * Consent is not optional here: relaying spends somebody else's bandwidth
   * and battery, so this field only ever appears because a person turned it
   * on, and it disappears again the moment they turn it off - see
   * `RoomSession.setAssist`.
   */
  assist?: AssistOffer
  /** True when this entry is not an arrival: an answer to somebody else's
   *  arrival, or the empty entry a device publishes as it leaves. Neither
   *  provokes an answer, which is what stops the room talking to itself for
   *  ever. Absent on a first announcement. */
  reply?: boolean
  /**
   * True when this device is an automated participant: an agent that acts
   * for a person, or for itself, and is in the room to read, write and
   * listen rather than to be looked at.
   *
   * Self-declared, and a claim like everything else here - nothing stops a
   * person's browser saying it and nothing stops an agent not saying it.
   * What it is for is consent: a member can choose not to send media to
   * anything that says it is an agent (see `RoomSession.publishTracks`),
   * and a room can show which of its members are people. An agent that
   * hides the flag gets media it was not meant to have, which is the same
   * betrayal as a person recording a call, and no protocol prevents either.
   * Absent on every entry that is not one, so the wire is byte-identical
   * for a client that has never heard of agents.
   */
  agent?: boolean
  /**
   * Whose agent this is, said by the principal rather than by the agent.
   * Carried only on an entry that says `agent: true`, and only ever seen
   * by a reader after `decodeRosterEvent` verified it: a proof that does
   * not verify costs the claim, not the entry, exactly as a hostile name
   * costs the name. Absent on every entry that has none, so the wire is
   * byte-identical for a client that has never heard of ownership.
   */
  owner?: AgentOwnership
  /**
   * True on the last entry a device publishes: it has left the room.
   *
   * Departure is a fact, not a guess made from an empty track list - a device
   * with everything switched off looks the same as one on its way out, and
   * only one of them should vanish. A receiver drops the device at once
   * rather than waiting out the presence timeout, and remembers when it left
   * so an entry from before the farewell, delivered late by a slower relay,
   * cannot bring it back. A client that does not know the field sees an
   * ordinary answer carrying nothing, and evicts the device on the timeout
   * as it always did. Absent on every entry that is not a farewell.
   */
  left?: boolean
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

/**
 * The room's mutable configuration: where to forward, and which ICE servers
 * to use. Encrypted to the room key and published as an ephemeral event, so
 * a relay sees the room id and nothing else.
 *
 * It carries a device credential for the same reason a roster entry does:
 * without one, anybody who ever held the room key - a guest who left, a
 * screenshot of the link - could still repoint the room's forwarder list.
 * With one, that ability expires when the credential does.
 *
 * Last valid writer wins, ordered on `updatedAt`. That is honest rather than
 * ideal: any member can publish a descriptor naming its own forwarder. What
 * stops that mattering is that media through a forwarder is encrypted under
 * a key derived from the room key, which no forwarder is ever given - so the
 * worst a member can do by winning this race is choose whose bandwidth pays.
 */
export interface RoomDescriptor {
  /** The device that published this descriptor. */
  device: string
  /** The participant that device speaks for. */
  participant: string
  /** Proof that `device` speaks for `participant` in this room. */
  credential: DeviceCredential
  /** The publisher's room admission proof. Required by gated readers. */
  proof?: KindredProof
  /** Forwarders this room may promote to. Order is not authoritative -
   *  `selectForwarder` imposes its own total order so every client agrees. */
  forwarders: ForwarderRef[]
  /** STUN/TURN servers offered to every member. */
  iceServers: IceServerRef[]
  /** Unix seconds. */
  updatedAt: number
}
