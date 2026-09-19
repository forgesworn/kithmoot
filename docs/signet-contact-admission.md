# Draft: Signet-backed room admission

Status: implementation design, not an enabled room policy. Existing room proof
validation remains authoritative. Contact checks, ownership attestations and
transport cards do not themselves admit a participant.

## Authority and consent

A room creator selects an explicit minimum tier (Ken, Kith or Kin) from their
own active, identity-scoped Signet grant. No tier permission, absent contact,
truncated-away contact, expired projection, revoked grant or unreadable cache
means no admission. A block always wins. Readers do not substitute their own
contact lists for the creator's decision. A bot's tier is its own; its owner's
tier and ownership attestation cannot satisfy the gate.

The creator must pin an admission issuer in the room policy before sharing its
invitation. NIP-07 and NIP-46 sign ordinary Nostr events, not arbitrary Schnorr
hashes, so the existing raw-hash KindredProof writer is not a sufficient browser
integration. Add a versioned signed-event proof that binds issuer, participant,
room ID, exact policy revision, minimum and observed tier, nonce and expiry.
Do not expose the underlying contact grant ID, contact ID, notes or check history.
Expiry cannot exceed the active projection or the responder's own delegation.
The ordinary event type and canonical payload need frozen interoperability
vectors and maintainer review alongside the existing invitation wire.

## Requester and responder boundaries

A requester must prove possession of its participant identity, bound to the
invitation request and responder challenge, before a tier decision is made.
A self-reported participant string is not proof of possession. Joiners retain
and present the resulting proof in authenticated roster messages; every room
reader validates the same pinned issuer, policy revision and room binding.

Current invitation delegations let admitted members answer new requests. They
must not bypass a creator's tier policy. Initially keep gated admission with an
explicit creator/keeper authority; later delegates need a signed scope naming
the policy and authority, with bounded depth, expiry and a current read grant.
An offline or locked authority leaves admission pending. Do not distribute the
creator's Signet rail credentials or quietly turn a gated room into an open one.

Fresh tier/block and account checks run both before requesting a signature and
after a delayed hardware response, before returning a proof or room key. Replays
cannot obtain a broader tier or a later expiry. Existing holders retain what
they already learned: withdrawing admission requires the room's epoch/key
rotation process, not a contact-card repaint.

## Bounded implementation sequence

1. Signed-event proof schema, canonical vectors and validation alongside existing
   raw proofs; reject ambiguous dual proofs and unsupported policy versions.
2. Participant possession proof bound to the invitation transcript, then
   creator/keeper issuance from a fresh account-bound grant.
3. Persist proof with the join admission; transport it in credential-authenticated
   roster entries, including reload, expiry and epoch transitions.
4. Explicit creator UI and local two-browser acceptance. Test stranger keys,
   wrong room/issuer/revision, missing scopes, cache faults, revoked/expired
   grants, block during hardware approval and a delegated-responder bypass.

## Returning a word check to Signet

This is a separate capability and consent path. A completed cryptographic
exchange is not a human comparison. Only the comparing user's explicit action
may propose a check under their selected identity and grant. Use an authenticated
bounded proposal mailbox with an idempotency key and replay floor. Include the
peer key, method and human-confirmed timestamp; exclude nonces, spoken words,
room membership and transcripts. Signet checks fresh grant permission, identity
scope and blocks, then offers owner review. An app proposal cannot assign Kin,
change membership, mark a mutual check or silently become accepted evidence.
Expiry, conflicts, revoked grants and storage failure leave no accepted check.
