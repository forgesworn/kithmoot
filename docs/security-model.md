# Security and privacy boundaries

This describes the implementation reviewed on 12 October 2026 at
`18b6de69270f2a5b66c8b71aa53158b4427c6855`. It separates ordinary rooms from
optional transport modes and the development MLS preview. It is a source
review, not a new deployment, independent audit or physical-device acceptance.

## Ordinary room encryption and recovery

Ordinary rooms use an authority-controlled epoch key schedule. Chat uses
NIP-44 v2 with a channel key derived from the current room epoch. The outer
event is signed by the room device key. The participant identity is inside
the encrypted payload, together with the message and display name.

A removal rekeys the room for the remaining devices. It does not erase
anything a removed member already received. Invitation rotation retires an
admission capability; it does not remove members already admitted. In an open
room, a removed person who still holds a working invitation can return under
a fresh participant identity. Rotate the invitation when that matters.

Supported web devices renew credentials with fresh seal keys, signed by the
participant identity. A subsequent epoch can then be sealed to the new key.
This can heal a **copied room device key** if the participant signer remains
uncompromised, senders have accepted the renewed credential, the copied
credential has expired and the room advances to a new epoch.
It does not heal an attacker controlling the running browser or participant
signer, and legacy devices without seal keys still receive device-key-sealed
copies. Do not assume every device or paired client has this protection.

Scheduled rekeying is optional. `RoomAgent` defaults to no cadence; an
operator must configure `--rekey-every`. Scheduling advances epochs, but is
not a per-message ratchet. Ordinary rooms currently make **no forward-secrecy
claim**: retained epoch and seal keys, re-derivable grants and local history
remain relevant after compromise. The history window is a retrieval policy,
not proof that all copies of a secret have been erased. The
[erasure audit](2026-10-05-erasure-audit.md) and
[key-schedule follow-up](2026-10-06-key-schedule-next-steps.md) record the
remaining work.

Source: [chat codec](../src/chat.ts), [session](../src/session.ts),
[agent defaults](../src/agent.ts) and [scheduler](../src/rekey-schedule.ts).
The circle and epoch implementation comes from the pinned `@forgesworn/fold-kit`
dependency; the corresponding `src/` files here are re-export shims.

## Browser storage and signers

An external signer keeps the signed-in participant secret outside the app's
ordinary `localStorage`. That does not make the browser's room secrets an
encrypted vault. The ordinary web app stores room device secrets, seal
secrets, retained epoch keys and admissions through its `localStorage` adapter
without application-level encryption. A visitor's participant secret is also stored
locally. Pasted `nsec`/`ncryptsec` participant secrets are held in page memory
only, as described in [the identity guide](nostr-identity.md).

Someone who can read the browser profile can therefore acquire retained room
capabilities and keys even when the participant uses an external signer.
Malicious code executing in the app's origin can use secrets and plaintext
available to that page. Signing out of an account is not the same operation
as forgetting every saved room.

The [Link carrier vault](browser-link.md),
[Bothy routing consent store](browser-room-activation.md) and
[MLS persona store](browser-mls-integration.md) use encrypted IndexedDB with
non-extractable keys for their own records. They do not migrate ordinary room
storage, and non-extractability does not prevent an authorised running page
from using a key. Restore-witness checks belong to the separate MLS preview.

Source: [device store](../app/src/device-store.ts),
[retained epochs](../app/src/room-epoch-store.ts) and
[app storage and identity wiring](../app/src/main.ts).

## What transport operators and peers learn

| Path | Protection and remaining disclosure |
| --- | --- |
| Ordinary Nostr room events | Contents are encrypted. Relays see room/channel identifiers, device signing keys, timestamps, event sizes and connecting network addresses. Fresh device keys per room reduce direct key linkage; they do not prevent IP or timing correlation. |
| Account records and profiles | Participant-signed bookmarks, read positions, optional NIP-42 authentication and public-profile lookups are separate identity-bearing traffic. They can link an account to activity. |
| Quiet chat | Padded gift wraps and five-minute filler slots reduce direct message authorship and timing disclosure. Presence, signalling and rekeys retain their ordinary routes; network addresses and traffic correlation remain. Calls are not quiet. |
| Default calls | Direct media uses WebRTC transport encryption. Direct peers can learn network addresses; configured STUN, TURN and forwarders see connections. Forwarded media additionally requires the supported encoded-media encryption path. |
| Relay-only calls | **Hide my IP address from other people in this call** uses authenticated TURN servers, removes STUN and sets `iceTransportPolicy: 'relay'`. Without a usable TURN server it refuses the call; it does not silently become direct. The TURN operator still sees the connection. |
| Bothy room routing | Pairing alone changes no room. Explicit activation selects a scoped private route and holds on expiry, account changes or route failure instead of silently publishing publicly. The current scope is ordinary main-chat text, presence and control before the first rekey. Calls, new invitations, quiet rooms and ungranted channels/epochs are unavailable. Account/profile traffic remains separate; Link observes connection timing and volume. |

These modes reduce particular disclosures; none is a general anonymity claim.
Optional infrastructure can become necessary for a selected privacy mode.
Privacy-preserving refusal is part of that mode, rather than permission to
downgrade to another route.

Source: [quiet transport](../src/quiet.ts),
[relay-only ICE](../app/src/relay-only.ts),
[media encryption](../src/media-crypto.ts) and
[Bothy activation and acceptance limits](browser-room-activation.md).

## Files and agents

Shared file uploads are off by default and require explicit consent to the
destination. Files are encrypted before upload; the portable envelope uses
AES-256-GCM with fresh key material and size padding. The shared server can
still observe network addresses, blob hashes, padded sizes and upload/download
timing. Ciphertext may be publicly downloadable. Ordinary file announcements
can expose blob metadata; quiet rooms suppress the bare announcement and carry
the details inside encrypted chat. Deleting a stored blob or retracting a
message cannot erase recipients' copies.

An admitted agent can read room content on the same terms as other members.
Sender-side media consent limits what it hears. If its operator chooses an
external model provider, authorised plaintext sent to that provider crosses
another trust boundary. See [running your own bot](your-own-bot.md).

Source: [file consent](../app/src/file-storage.ts),
[encrypted envelopes](../packages/context/src/blossom.ts) and
[agent design](agents.md).

## MLS is a separate development preview

The browser entry point requires both Vite development mode and
`VITE_BROWSER_MLS_PREVIEW=true`. An ordinary production build does not enable
MLS, and ordinary rooms retain their existing epoch scheme.

The current [room custody preview](browser-mls-room-custody-preview.md) can
create a local witnessed room and explicitly run one bounded manual round.
Authenticated invitation joining and uncertain-join recovery remain held.
There is no automatic background driver. Encrypted custody and witness
fixtures are evidence for those components, not acceptance of a complete
production room journey or proof of native/browser interoperability.
