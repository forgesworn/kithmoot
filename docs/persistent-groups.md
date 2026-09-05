# Persistent groups

The web creation form defaults to **Group: come back any time**.  A group can
be empty for days and admit a new member without a creator or keeper online.
**Temporary meeting** retains the v2 live handshake, bounded delegation and
twelve-hour local recovery.  A creator can use **Keep as a group** to publish
a group invitation with a fresh bearer for an existing conversation,
retaining its room secret, history and inviter.  Old meeting bearers cannot
decrypt the stored group invitation.  Existing v2 links keep their original semantics; share
the updated link for asynchronous joining.

## Wire format

The v3 fragment carries `v: 3`, `j` (32-byte bearer), `h` (inviter pubkey),
and the existing relay, ICE, policy and name fields.  It contains no traffic
secret.  `RoomInvitation.persistent` distinguishes it from v2.  Unknown link
versions are refused.  Existing v1/v2 links remain readable.

The creator publishes regular kind **1463**, `GROUP_INVITATION`, signed by
`h`, with one `d` tag containing the existing bearer-derived invitation id.
The encrypted JSON body is `{v:3, room, secret}`, with a base64url-no-padding
epoch-0 secret.  Its NIP-44 v2 symmetric key is HKDF-SHA256 of the bearer,
with no salt and info `kithmoot/v3/group-invitation-key`.  That domain is
separate from the live request key and room key.  The decoder verifies the
event signature, pinned author, invitation id, version, secret length and
derived room id.  No inviter or delegated signing key is given to members.

Creation waits for relay publication acknowledgement before exposing the
link.  Rejection or timeout leaves the form retryable.  A new member queries
1463 and the existing signed kind-1461 retirement together and waits for end
of stored events.  A retirement wins even when the welcome was replayed
first.  Missing or incomplete results fail rather than admitting from a
partial result.  A group join publishes no live invitation request.

This uses the regular-event and EOSE conventions in
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) and the
existing [NIP-44 v2](https://github.com/nostr-protocol/nips/blob/master/44.md)
encryption implementation.  Kind numbers remain provisional KithMoot kinds.

## Persistence and limits

The app retains group membership on this device by default; Room details
offers an opt-out.  The group record has no twelve-hour expiry.  Creator
records require an explicit persistent storage marker to skip their old
expiry; changing a URL alone does not extend it.  Opening an old v2 link
after conversion cannot erase the saved group authority.  Forgetting a room removes retained admissions, including
earlier rotated links, and creator recovery for it.  The current tab's cache
is also removed by the Forget action.  Other open tabs can still hold keys
in memory.  Device passes and secondary-device pairing keep their separate
expiry rules.  Nostr bookmarks continue to carry encrypted links, not creator
private keys; an updated client can resolve the stored group invitation.

The bearer plus a saved 1463 event is durable cryptographic access to epoch
0, including its retained history.  Retirement is cooperative, not remote
deletion or cryptographic revocation.  A hostile relay can withhold a
tombstone, and a holder can retain the envelope and key.  The relay pool's
EOSE reflects reachable relays and its normal timeout policy, not proof that
every possible relay was consulted.  Relays see invitation ids, inviter
pubkeys, timings and ciphertext sizes.  They do not receive the bearer or
plaintext secret.  Stored admission depends on relay retention and
availability, just as stored chat does.

Only epoch 0 is in the envelope.  Existing session rekey verification remains
in force; a group invitation cannot recover a later epoch or override a
removal.  Browser-created groups currently do not expose member removal,
managed named channels or keeper nudges.  Those managed-room services still
use the existing keeper.  This change removes the keeper requirement for
basic group membership, chat and calls; it does not add distributed group
administration or mobile push delivery.

The JS library and web app read v3.  The separately maintained Android app
needs its own protocol and persistence update before using these links.

## Evidence

`src/persistent-invitation.test.ts` checks stored-only agent admission,
signature/bearer validation, retirement ordering, missing EOSE and conflicts.
`app/src/invitation-store.test.ts` checks long-term recovery, temporary
expiry, opt-out and forgetting.  `test/persistent-groups.spec.ts` drives
fresh browser contexts against a real test WebSocket relay: everyone leaves,
a new member joins two days later, persisted browsers return four days
later, an old link is retired, a meeting is converted, and publication fails.
Browser time is advanced for the days-later cases; this is automated evidence,
not a multi-day production observation.
