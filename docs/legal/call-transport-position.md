# Call transport: current position and planned design

Draft, 23 October 2026. Not legal advice; not reviewed by a lawyer. Prepared
against web source `e8eeb5704bd101975766dc2f7bb7a42d475306ae` and Android
source `9efe3db642a22ccc08b1f87e4a4d5595184a0597`, with a host configuration
readback on 23 October 2026. Source state is not proof that every installed
client has updated. The law is in jurisdiction-kit's
[`law/gb/online-services.md`](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md),
verified 28 September 2026; section 2.11 adds primary sources read on
23 October 2026. `[P]` means primary source read; `[U]`
means an unresolved interpretation. Neither mark is legal advice.

## What exists today

ForgeSworn publishes the public app and update files. The public TURN
credential endpoint returns 410 (`deploy/Caddyfile.kithmoot:133`); the web
build needs an explicitly configured endpoint to use a credential service
(`app/src/main.ts:927`). Current web source chooses independent Cloudflare
STUN by default (`src/ice-defaults.ts:55`). An installed client can still
contain an older default.

People can explicitly configure their own TURN URLs and login on each
device. Web storage is localStorage (`app/src/call-relay.ts:23`, `:37`).
Android uses a Keystore-encrypted, no-backup file (`media/CallRelayStore.kt:8`,
`storage/EncryptedRoomStorage.kt:60`, `:68`, `:105`). These logins are not
published to Nostr or inserted into room invitations. A selected relay sees
IP addresses, authentication identity, timing and volume, and carries
encrypted WebRTC packets; it is not given the media session keys.

A separate private coturn instance is running for an arranged call with two
accounts. Host readback confirmed authentication, two configured accounts,
coturn output discarded, and Docker logging disabled. The old public
listener on 3478 is stopped. This private instance is not a public app
default and does not issue credentials to the public. Host and hosting-provider
network logs have not been audited; do not translate the application logging
settings into a promise that nobody records metadata.

`[INPUT: confirm whether the private facility is operated by an individual
solely for personal communications, or in a project/business capacity.
Record the capacity and relevant contact privately; do not infer it from
the hostname or publish a natural person's name.]`

## Position and limits

For the public distribution, the intended position is a publisher with
independent infrastructure choices. Applying that position to the actual
distribution remains a reasoned reading `[U]` (law note 2.2). Publishing
software and operating the separate private deployment must not be treated
as the same activity.

The statute distinguishes control over the user-to-user service from an
access facility `[P]`. Whether a particular TURN implementation falls within
that infrastructure role remains unresolved `[U]` (2.11). A single relay
login or one installed application does not establish that there is only
one legal user. Friends-only access and encryption do not establish an
Online Safety Act exemption by themselves (2.1, 2.10).

Purely personal processing is outside UK GDPR `[P]`; applying that position
to this private facility depends on the operator-capacity input above `[U]`
(3.9). Data protection and investigatory-powers questions remain separate
from Online Safety Act scope (3 and 5).

The historical closure timetable remains in `closure-record.md`. This
document establishes no fresh assessment start date and no retrospective
exemption. It does not reactivate archived assessments or adopt their drafts.

## Planned design, not shipped functionality

The owner's decision on 23 October 2026 is simple setup with an independent
relay provider, plus self-hosting. ForgeSworn will not operate the general
call service. The proposed profile import and connection check are research
and design work; they are not represented here as released features.

The provider or self-hosting operator supplies credentials directly. No
ForgeSworn shared provider account, root key, credential issuer or room
directory is proposed. Credentials remain device-local and relay-only mode
must retain its privacy guarantee. Any future provider recommendation needs
consumer eligibility, contract, metadata and network qualification; research
has not approved a named provider as a default.

Before adding a shared sponsor account, central issuer, discovery service,
public forwarding pool or media-processing server, revisit the actual service
boundary. An outsourced server does not automatically remove the app
operator's role `[U]` (2.2, 2.11). A narrow legal review of that boundary is
optional where its answer would change the design.

## Documentation and publication

The public privacy, terms and report pages must describe the device-selected
relay, its metadata and the distinction between retired public services and
private deployments. They must not promise that a provider keeps no logs or
that all self-hosters are exempt. The self-hosting runbook remains
`docs/private-call-relay.md`; passwords and private account files are never
part of a legal notice.

This remains a draft when published. Publication records the findings and
open questions; it does not establish a legal exemption or adopt the terms
as a binding service agreement. Operator capacity, existing privacy
legal-basis choices, and the provider choice remain owner inputs.
Recording/transcription, other countries'
laws and a full product audit are outside this update.
