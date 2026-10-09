# Coordinated browser vault security review

Review date: 9 October 2026. Initial reviewed head:
`9f24ed184b928f3c594ce5d0cfe0b3a871d57227`, against main `888fdb2`.
Follow-up reviewed head: `24df5a02873f312b4ac993d836ddd3d185263224`.

**Final scoped verdict: no blocking findings for merging the
production-disabled vault slice at the follow-up head.** The initial review
required three corrections; all three are resolved in the reviewed source.
Production remains disabled, and there is no room/UI caller. This verdict
does not authorise enablement or close broader P3-03c acceptance.

The owner authorised an available reviewer agent in place of P3-03's named
Opus/Astra reviewers. This separate agent continued the independent review
role for the new vault slice. This is an agent code review, not a human
cryptographic audit. The earlier foundation review does not approve these
new paths.

## Initial findings and reviewed resolutions

File/line references in the findings below refer to the initial head.

### V1: in-flight local reads outlive confirmation invalidation

`app/src/mls-persona-coordinator.ts:63-80` captures the confirmation only at
the start of `readConfirmed`. After its asynchronous work and cleanup, it
checks the caller's `current()` but does not check whether that exact
confirmation still exists or its confirming context is still current.

An explicit `invalidate(persona)` or a queued `transact`/`status` clears
confirmation immediately without necessarily changing the caller context.
If that happens while the local read awaits decryption, the callback or
cleanup, the read can still return `active` and release a box header using
withdrawn authority. The existing completed-pending-check test does not cover
this in-flight race.

Required correction: retain an identity/token for the exact confirmation and
check that it remains authoritative, together with its confirming context,
at successful release and again after lock cleanup. Test explicit invalidation
and a queued coordinator operation at controlled await boundaries; neither
may yield an active local result from the old confirmation.

Resolved at the follow-up head: `readConfirmed` retains the exact confirmation
object and checks both its identity and confirming context after storage read,
callback/finish and lock cleanup. A replacement confirmation cannot revive
the old read. New controlled-await tests invalidate or queue `status` inside
the second box read, and invalidate during its cleanup; all expect the header
to be withheld.

### V2: leaf reply validity is not rechecked after awaited commit/cleanup

`app/src/mls-coordinated-vault.ts:268-294` checks the RPC, binding and
credential expiry before computing the signature, then awaits staging,
witness advancement, promotion and endpoint shutdown. A slow reply can
complete after those deadlines. The method still returns a successful
signature. `acceptSignReply` at lines 296-303 checks provenance and signature
but also omits release-time expiry checks.

Required correction: after awaited coordination, withhold a reply whose
RPC deadline or binding/credential validity has expired, and recheck validity
when accepting it for the current engine operation. Keep the already
committed journal intact; expiration is not permission to undo a witnessed
decision. Test advancing the fixture clock while an advance reply or channel
shutdown is delayed, and accepting a previously returned reply after expiry.

Resolved at the follow-up head: the signing path retains the minimum of the
enrolled credential expiry and binding expiry, alongside the RPC deadline.
It checks those after coordination and records them with reply provenance
for acceptance-time checks. The RPC deadline stays inclusive; credential and
binding expiry remain exclusive. Tests cover delayed advance and cleanup,
acceptance after deadline, binding expiry before the RPC deadline and an
enrolled credential expiring before a longer credential presented in the
binding. The committed journal remains retained. Box reply provenance also
tracks credential and authentication-header validity.

### V3: a regressing clock can reuse a box authentication event id

`app/src/mls-coordinated-vault.ts:335-339` removes timestamp entries as soon
as their timestamp is earlier than the current clock. Sign request A at T,
then request B at T+1, which removes A's entry. If the clock regresses to T,
signing A again uses T and recreates the same Nostr event id. The box refuses
that mutation as replay, contrary to the vault's within-lifetime no-repeat
requirement in contract section 6.2.1.

Required correction: hold signing on clock regression or enforce a
within-lifetime monotonic clock floor while respecting the maximum allowed
lead over the actual vault clock. Test forward-then-backward clock movement
and verify no successful response reuses an event id. No persisted timestamp
journal is required or recommended for this unjournalled operation.

Resolved at the follow-up head: an in-memory lifetime clock floor refuses
regression before cache eviction or timestamp allocation, and release checks
again for a regressed clock. The new regression signs A, advances the clock
and signs B, moves the clock backwards, requires refusal, then checks that
recovery cannot reuse A's event id. The floor and timestamp cache remain
unpersisted, preserving the unjournalled contract.

## Reviewed boundaries and evidence

Source inspection covered the typed record/schema, device enrolment and
replacement, consent and leaf journal, migration freeze/source locking,
read-only confirmation, box request validation, reply provenance and account
invalidation against P3-03 and contract sections 4 and 6.

The source retains several sound boundaries: migration freezes the legacy
source before staging at a bound destination; a retry cannot overwrite an
existing migrated record; approvals and leaf decisions share a witnessed
candidate; device replacements retain tombstones; unsupported typed records
fence; prompts occur outside writer ownership and contexts/scopes are
rechecked afterwards; box requests use the contracted route allowlist and
device key. These observations do not cancel the findings above.

The reviewer inspected the new browser fixtures and assertions. Existing
tests cover interruption, lost advances, replayed decisions, prompt races,
cross-tab withdrawal, restoration, missing keys, migration and forward clock
movement. They do not exercise the three scenarios above at the reviewed
head. The follow-up adds the controlled regressions described above, whose
hooks and assertions were inspected independently. The reviewer independently
ran pinned-WASM verification and `git diff --check 888fdb2...HEAD` again at
the follow-up head; both passed. Heavy browser/unit suites were left to the
releasing agent to avoid competing runs. Reported suite counts are therefore
not claimed as independently reproduced here; final test outcomes belong in
the release validation record.

## Scope limits

The follow-up source review closes V1-V3. This slice remains
production-disabled. Full-app consent
and vault UI, room/box callers, authenticated principal and generation wiring,
real-Bothy typed-signing acceptance, Android/browser composition and physical
device acceptance remain separate work. The local API trusts its app context
and callbacks; same-origin script compromise is outside its custody guarantee.
Migration cannot establish historical independence for an unwitnessed legacy
source, and older builds do not understand its freeze marker.
Changes to the reviewed security paths or new transaction/signing callers
require a fresh review of that changed scope.
