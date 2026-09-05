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
  /** Roster / presence, encrypted to the room key.
   *
   *  Deliberately EPHEMERAL, and deliberately not a stored or addressable
   *  kind. Presence is live state: an entry a relay kept is a claim that
   *  somebody is in a room they left an hour ago, and it leaves a durable
   *  public record that the room exists at all - which the whole design is
   *  built to avoid ("nothing about the room is public"). The cost is that a
   *  device joining later is never sent what it missed, so arriving devices
   *  announce and devices already present answer; see
   *  `RoomSession.announce`. */
  ROSTER: 20461,
  /** Ephemeral gift wrap carrying SDP and ICE. Reused from NIP-AC deliberately. */
  SIGNAL_WRAP: 21059,
  /** Inner signalling event, wrapped in SIGNAL_WRAP. Never published bare. */
  SIGNAL: 20462,
  /** Chat message, encrypted to the room key and published once, exactly
   *  like the roster. Unlike the roster this is a DURABLE kind (regular
   *  event range, not ephemeral) - chat history is the point, so it must
   *  survive a relay restart and be there for late joiners. */
  CHAT: 1460,
  /** A second device asking to be credentialled for this participant,
   *  encrypted to the room key. Ephemeral: this is a live handshake between
   *  two devices that are both present, and a stored one would be a durable
   *  record that the room exists. */
  PAIRING_REQUEST: 20463,
  /** The reply, carrying a room-scoped expiring device credential. Ephemeral
   *  for the same reason. */
  PAIRING_GRANT: 20464,
  /** Room descriptor: the room's mutable config - its forwarders and its ICE
   *  servers - encrypted to the room key.
   *
   *  Ephemeral, for the same reason the roster is: a stored descriptor is a
   *  durable public record that the room exists at all, which the whole
   *  design is built to avoid. The cost is the same too - a device joining
   *  later is never sent what it missed - and it is paid the same way, by
   *  members answering an arrival.
   *
   *  This is deliberately NOT where the access policy lives. The policy
   *  rides the join URL so that agreement about who may enter is structural
   *  and nothing has to say who may replace it; see `docs/decisions.md`.
   *  Forwarders and TURN are different config on different terms: they have
   *  to change while a call is running, and getting them wrong costs
   *  bandwidth rather than admission. */
  DESCRIPTOR: 20465,
  /** A prospective member proving possession of a room invitation.
   *
   * Ephemeral deliberately: it is a live rendezvous with an inviter, not a
   * request a relay should retain. The public `d` tag is derived from the
   * bearer capability; the request body is encrypted under a separate key
   * derived from that capability. */
  INVITATION_REQUEST: 20466,
  /** A delegated responder's encrypted response carrying the room traffic
   * secret and its root-authenticated, room-bound delegation chain. Addressed
   * to the requester's one-use pubkey; knowing the bearer does not let
   * somebody nominate a responder or substitute a room. Ephemeral for the
   * same reason as the request. */
  INVITATION_GRANT: 20467,
  /** A durable, creator-authenticated tombstone for one invitation.
   *
   * Unlike the live request/grant exchange this MUST be a regular stored
   * event: a delegated responder that was offline when the creator rotated
   * the link has to learn that fact before it starts answering the old link
   * again. The invitation id is unique, so one valid retirement is final. */
  INVITATION_RETIREMENT: 1461,
  /** A persistent group's invitation, signed by the pinned inviter and
   * encrypted under a separate bearer-derived key. Regular stored event:
   * newcomers can enter with every member offline. Contains epoch 0 only;
   * it never grants authority to rekey or bypass a later removal. */
  GROUP_INVITATION: 1463,
  /** A room moving to a new epoch: a fresh traffic secret, sealed per
   * remaining device, with the participants removed at this step named.
   *
   * Durable, and addressed by the public room id, so a client can find the
   * room's current epoch from the id alone and know it is behind before it
   * says anything under a key that is dead. The body is encrypted to the
   * previous epoch's key, so a relay sees the room id, the epoch number,
   * the authority's pubkey and a size, and nothing about who was kept or
   * removed. Signed only by the room's authority, the root inviter pinned
   * in the link. See `epoch.ts`. */
  ROOM_REKEY: 1462,
  /** A member that missed a rekey - it was offline, or it is arriving now -
   * asking the authority for the current epoch, proving which participant it
   * speaks for with its device credential. Encrypted to the authority and
   * ephemeral: it is a live handshake, not a record. */
  EPOCH_REQUEST: 20468,
  /** The authority's answer, sealed to the asking device: the current epoch's
   * secret and the removed set, or a refusal. Ephemeral for the same reason. */
  EPOCH_GRANT: 20469,
} as const
