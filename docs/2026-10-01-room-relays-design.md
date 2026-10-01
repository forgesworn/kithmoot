# Room relays: fixed at creation, always used by everyone

Status: design, not built. Decided 2026-10-01: the relays a room is created
with are **always included** in every participant's pool (merged with their
own, never replacing them), and they also travel **inside the signed group
invitation** (kind 1463) so stale bookmarks and project links converge.

## Why

Roster, call signalling (`SIGNAL_WRAP`) and chat all go through one relay
pool per participant. Today two members of one room can end up on disjoint
pools, and then neither sees the other's offers:

- Web `RelayConnections.#configuration` (app/src/relay-settings.ts): a saved
  per-room config wins outright and link hints are ignored.
- `adoptRoomRelays` (main.ts) writes the authority's `relays` op into that
  saved config and cuts it to 8, dropping the member's own relays.
- Links are re-encoded from the sharer's whole pool, so bookmark and project
  links drift.
- Android: a link with no relays falls back to the joiner's own settings;
  `applyRoomRelays` cuts to 8 and overwrites the saved relays.

## Model

- **C**: the room's relays, fixed at creation, never changed, at most 8.
- **O**: the newest verified `relays` control op, additive as today, at most 8.
- **R = C ∪ O**, at most 16.
- Each participant's pool = R first, forced read+write, then their own
  relays (saved for this room, else inherited snapshot, else defaults),
  filled to 16. Own relays are cut first; R never is.

Any two participants then share at least one relay, so no per-kind routing
change is needed.

## Wire format (fold-kit 0.4.0, on top of 0.3.0's `ends`)

- Group invitation body key order: `v, room, secret, ends, relays`. `relays`
  omitted when absent, so the plaintext is byte-identical to 0.3.0.
- When present: 1–8 distinct strings, each passing `isSafeRelayUrl`, in
  canonical form (`wss://host/` with trailing slash, same as Android's
  `canonicalRoomRelayUrl`). Any failure refuses the whole envelope, as `ends`
  does; never silently truncated.
- Disagreeing signed copies: the newest `created_at` wins for `relays`.
  (Contrast `ends`, where the earliest end wins.)
- Old readers ignore the key.

## Choosing C at join, open and rejoin

1. A signed invitation `relays` wins, replacing a C learnt from an unsigned link.
2. Else the C already stored for the room.
3. Else the link's `r`, on first sight (temporary rooms, legacy links).

At creation C is the read+write entries of the creator's inherited snapshot,
at most 8. Links are encoded from C then O, cut at 8.

## Storage

- Web: a room-relay layer in `RelayConnections`, own key
  `kithmoot.room-relays-fixed.v1` = `{roomId: {c, signed}}`; `setRoomRelays`
  updates live pools via `pool.setRelays`. New `MAX_POOL_RELAYS = 16` in
  src/relay-pool.ts for `normaliseRelayConfig` (links, saved lists,
  invitations and the op stay at `MAX_RELAY_HINTS = 8`).
- Android: `SavedRoom.roomRelays` + `roomRelaysSigned`; `RoomRelays.atOpen`
  puts room relays first and never cuts them.

## Migration

- Creators: `keepGroupInvitationAlive` republishes every 6 hours, so `relays`
  reaches existing invitations without anyone acting.
- Members of a persistent room with no signed C: one background
  `requestPersistentRoomAdmission` after opening; adopt its `relays`.

## Open question

Android anonymous (Tor-only) and circle-consent rooms keep exactly their
saved relays today. Proposed: merge R only where `TorOnlyRelayUrls` /
the consent route accepts it, otherwise show a notice. Needs a decision.

## Order of work

1. fold-kit: `feat: room relays in the group invitation`, tests, release 0.4.0.
2. kithmoot (after the 0.3.0 bump): bump to 0.4.0 + api snapshot;
   `MAX_POOL_RELAYS` and the room-relay layer; creation/join wiring,
   `adoptRoomRelays` via `setRoomRelays`, `r` built from R; background
   invitation read; e2e; docs/protocol.md and persistent-groups.md.
3. kithmoot-android: :protocol field + web vector; `SavedRoom`,
   `RoomRelays.atOpen`, join paths, `onRoomRelaysReceived`, background read.

## Tests

- fold-kit: round trip; absent field byte-identical; key order with `ends`;
  >8/empty/unsafe/duplicate/non-string refused; old reader still decodes;
  newest copy wins.
- kithmoot unit: saved config ∪ room relays; room relays forced read+write
  and never written into the saved config; the 16 cap cuts personal first;
  live pools updated; the op adds without cutting personal relays.
- Android: mirror fold-kit cases plus the web vector; `atOpen`; `SavedRoom`
  round trip.
- e2e (test/room-relays.spec.ts), three local relays A, B, C: creator on [A];
  joiner seeded with `default:[B]` and `room:<id>:[B]`; assert the joiner
  connects to A, both see each other, media and chat flow both ways; reload
  the joiner from a bookmark whose `r` says [B] and assert A is still used
  and the rejoin works.
