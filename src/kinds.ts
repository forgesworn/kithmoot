/** KithMoot v1 wire kinds, frozen by docs/protocol.md. Registry submissions
 * are prepared in docs/protocol/kind-registration.json; pending registration
 * does not renumber existing rooms. Shared kinds keep their upstream meaning.
 *
 * `CREDENTIAL`, `CHAT`, `INVITATION_REQUEST`, `INVITATION_GRANT`,
 * `INVITATION_RETIREMENT`, `GROUP_INVITATION`, `ROOM_REKEY`, `EPOCH_REQUEST`
 * and `EPOCH_GRANT` moved to @forgesworn/fold-kit (see the T2.1 codec
 * cutover); this object spreads the kit's `KINDS` first, then KithMoot's own
 * remaining kind entries. The kit's `KINDS.CHAT` is byte-identical to what
 * this file used to declare, so the spread order changes nothing about the
 * value - only which module's object literal defines it. */
import { KINDS as CIRCLE_KINDS, MEMBER_EPOCH_KINDS } from '@forgesworn/fold-kit'

export const KINDS = {
  ...CIRCLE_KINDS,
  /** A device that missed a rekey asking the room's current members, not
   *  just the authority, for the epochs it missed: encrypted under a key
   *  derived from the epoch-0 room key, carrying the same admission proof
   *  as an epoch request. Ephemeral. The kit names it
   *  `MEMBER_EPOCH_KINDS.REQUEST`; it is spelt out here because a bare
   *  `REQUEST` key would sit ambiguously beside `EPOCH_REQUEST`. */
  MEMBER_EPOCH_REQUEST: MEMBER_EPOCH_KINDS.REQUEST,
  /** A member's answer, sealed to the asking device and signed by a
   *  one-time key: the missed secrets with the authority's own rekeys to
   *  prove them. Ephemeral. See `member-epoch.ts`. */
  MEMBER_EPOCH_GRANT: MEMBER_EPOCH_KINDS.GRANT,
  /** Reserved codecs only; no service enforcement in M2. */
  MEMBER_PASS: 20470,
  SERVICE_POLICY: 30460,
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
  /** A call starting or ending, for a phone that has the app closed and
   * must not wake for every presence heartbeat. Regular, so a socket that
   * just reconnected catches it with `since`, and every one carries a NIP-40
   * `expiration` two minutes out. Signed by a throwaway key and tagged only
   * with a daily rendezvous derived from the epoch key, so a relay cannot
   * tie it to the room's roster or to any device. See `call-bell.ts`. */
  CALL_BELL: 1464,
} as const
