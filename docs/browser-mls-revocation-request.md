# Browser MLS member revocation request foundation (P3-08)

This development-only slice implements the member-to-keeper wire boundary from
Vennel contract section 7.1. Production MLS remains disabled, and the production
app does not import this module.

## Protocol boundary

`createVmlsRevocationRumor` creates the unsigned inner kind 21350 rumour. Its
only fields are the requesting account, keeper, device, expiration, and bounded
session and box hints. The parser requires the exact field and tag set, binds
the rumour author to the authenticated kind 13 seal author, verifies its event
id, rejects duplicate hints, enforces the seven-day lifetime and ten-minute
future-skew limits, and accepts between one and 64 session and box hints.

`wrapVmlsRevocationRequest` identity-signs a kind 13 seal and encrypts it inside
a kind 1059 gift wrap made with a fresh ephemeral key. Seal and wrapper times
are independently backdated by up to two days. Only the keeper `p` tag is
visible outside the encrypted payload. Signer substitution, account changes,
oversized payloads, invalid randomness, and malformed or unauthenticated relay
material fail closed.

`sendVmlsRevocationRequest` selects only the keeper's verified latest kind
10050 DM relay list. It has no NIP-65 or configured-relay fallback and gives the
publisher `authenticate: false`, so the member identity must not be disclosed
through NIP-42. The publisher contract resolves only after at least one relay
has returned `OK true`; callers may set `NotAuthorised.requested` only after
that resolution. A missing relay list or a refused/uncertain publish leaves the
request unrecorded.

`vmlsMemberGrantReference` derives the member-side stable reference as
`SHA-256(UTF8("kithmoot/vmls-member-grant/v1") || box32 || device32)`.

## Active-room sender durability

The development MLS room record now retains the authenticated keeper identity
used at creation or join. A current member may journal removal of another one
of their account's devices with exact keeper, device, session, box and
`keeper:false` grant-reference bindings. The witnessed membership transaction
rejects a request that names a different roster device, omits the current
session, targets the requesting account as keeper, or differs from the engine's
non-keeper grants. Invalid caller input is refused without fencing a healthy
persona; a later mismatch in sealed persisted state fences it.

`requestRevocation` creates a fresh seven-day envelope from that witnessed
record. Relay refusal or uncertain publication leaves every grant at
`NotAuthorised { requested: false }`. Only after the injected publisher confirms
`OK true` does one witnessed transaction mark all exact request grant references
`requested: true`. That state means the request was sent, never that the keeper
performed revocation. Concurrent calls through one controller instance for one
operation share one attempt. Separate tabs or controller instances can each
publish while the durable requested flag remains false. A
restart may retry a retained `requested: false` operation, while a retained
`requested: true` operation returns without another directory read or publish.

`NostrVmlsRevocationTransport` is the concrete, still-unwired browser network
dependency. It asks at most six configured discovery relays for only the exact
keeper's kind 10050 events, with a per-relay event cap and finite deadline. An
empty result counts only after at least one relay returns EOSE; total silence is
an uncertain lookup and sends nothing. It drops wrong-author, wrong-kind and
invalidly signed directory events. The write opens a fresh pool containing only
the verified latest list selected by the protocol boundary, with an explicit
empty NIP-42 authentication set. The shared pool's 20-second silence budget
retries unanswered sockets; explicit `OK false` is never retried. The transport
waits at most two further seconds for slower targets after the first `OK true`,
then closes every socket. Both phases participate in the public-route barrier.

A crash after a relay's `OK true` and before the witnessed `requested: true`
commit can cause an at-least-once duplicate on explicit retry. The keeper inbox
must therefore deduplicate and validate requests; this slice does not turn an
uncertain acknowledgement into a sent claim.

## Development UI action

The production-disabled membership panel offers `Send request to keeper` only
for a witnessed active-room request whose MLS Remove is committed and whose
non-keeper grant rows all remain `requested: false`. It states that the public
DM relays see the recipient, connection address, timing and volume, and that a
sent request is not proof of receipt or revocation. The click obtains the
currently selected account identity, uses the injected bounded transport, and
leaves the action enabled for explicit retry after refusal or uncertainty.
After witnessed `requested: true` state, the action disappears and the engine's
bounded `requested, not performed` claim remains visible.

## Standalone sealed outbox

Every genuine roster read for a joined member retains same-person, non-local,
non-pending devices under the room's authenticated keeper. The observation is
stored inside the existing witnessed membership vault record, with a bounded
stable operation id, device, sorted room and box hints, first observation time,
and nullable sent time. Other identities, the local leaf, pending leaves, a
self-keeper room and unverified caller input cannot create a record. A later
room or box observation expands the exact record and clears an older sent time
so the new evidence cannot be misreported as sent. Each hint list is capped at
64 and refuses further evidence without evicting a retained hint or fencing a
healthy persona.

`BrowserMlsRevocationOutbox` reads and sends this record without opening the MLS
session. It fresh-reconciles the persona witness before reading, uses the
current account identity and bounded injected relay transport, then
fresh-reconciles again before storing `sentAt`. Both witnessed reads recompute
the operation binding and require its sender to be the open persona, so altered
state is fenced before it can select a keeper or record success. A refusal,
uncertainty, stale account, changed record or failed witnessed commit leaves the
retained record retryable. A restarted sender performs no directory read or
publication for a record whose sent time is already witnessed. As with the
active-room sender, a crash after relay `OK true` and before the second
witnessed commit can produce an at-least-once duplicate; the future keeper
inbox must deduplicate it.

## Evidence and remaining work

Unit coverage exercises strict framing and time bounds, NIP-59 round trips,
outer metadata minimisation, signer and author binding, hostile relay input,
verified kind 10050 selection, absence of fallback and identity AUTH, refused
publication, account invalidation, and the member grant reference. Browser
coverage exercises keeper persistence, real-engine non-keeper grants, restart
recovery, atomic requested-state persistence, refusal of a mismatched target
device without persona damage, fencing of altered stored bindings, and
standalone roster-evidence persistence across Chromium, Firefox and WebKit.

This remains a development-only sender boundary. It does not add a production
app import or room wiring, automatic background retry, a standalone UI action,
keeper inbox, dedicated endpoint lifecycle, operator prompt, or MLS/grant
revocation. Those remain open P3-08 work, and these modules must not be wired
into production before their gate evidence and the production security review
are complete.

## Private keeper inbox checks (development only)

The grant workflow panel has an explicit **Check selected Bothy privately**
action. Select a saved route on the dedicated grant connection and allow keeper
identification to that Bothy for this check. The concrete endpoint opens the
pinned Link event socket; successful keeper NIP-42 authentication precedes its
finite kind-1059 recipient query. Pairing does not itself grant event authority.
A refused, expired or unavailable keeper session produces an incomplete check.

This path performs no public DM directory lookup, public recipient query,
public AUTH or publication, and has no public fallback. The old public action
remains explicitly labelled and separately selected. Link bootstrap/carriers can
still expose connection metadata; the Bothy receives the authenticated keeper,
recipient filter, ciphertext, timing and volume. This is not anonymity or a claim
that all network traffic avoids public infrastructure.

The witnessed inbox retains distinct private cursors bound to keeper, saved
route id and pinned event URL. Public and private scans share the page budget.
Only a verified, processed retained page with a strictly older signed boundary advances its cursor. Existing
wrapper, recipient, seal, request, decryption-budget and membership checks remain.
A late account, signer, permission or route invalidation cannot authorise a read.

This change only reads requests already stored at that Bothy. Member-to-keeper
private sending is still unresolved: Bothy's non-keeper event sessions enforce
ordinary guest-event scopes, and a VMLS device grant does not automatically
authorise an ephemeral-author gift wrap. Neither public delivery nor a generic
callback is substituted when that private sender authority is missing.
Production MLS remains disabled; this does not close admission or continuity.

Using this development action writes the optional `privateScan` field in the
witnessed membership journal. Older development builds with the previous strict
schema may refuse that record; no downgrade or journal-reset migration is added.

Operation permission remains live throughout intake, including both decryption
layers, retained-grant lookup and witnessed prompt/cursor transactions. Signed,
query-matching unsupported outer shapes remain pagination boundaries without
using a signer. Forged events cannot supply a boundary. Timestamp pagination
retains the oldest signed second inclusively. NIP-01 EOSE, even with fewer than
64 events, does not prove that a server item/byte cap exhausted that second.
If the signed boundary cannot move backwards, or a page has no signed matching
boundary, the check remains incomplete at its existing cursor. It never
subtracts a second or repeatedly resets the cursor to the head. This can hold
older-history progress even after a short or empty page; safe continuation needs
a separately specified stronger Bothy paging API and is not claimed here.

Normal public and private **Check** actions use a fresh window ending at the
witnessed current time. A saved empty or held boundary therefore no longer excludes later
wraps solely because their timestamp is newer than that boundary. Separate **Check older requests** actions resume the
saved retained inclusive boundary. The selected mode is captured at the click,
alongside route and identification permission. Both modes share the same
witnessed one-page and decryption budgets.

Fresh probes create an initial retained boundary if none exists, but never
move an existing backfill cursor, even after successful intake. Retained checks
can move only to a strictly older signed boundary; an ambiguous or expired
backfill window holds without becoming a new head. No mode claims that retained
history is complete. Safe progress through a blocked timestamp still requires
a stronger paging API; this patch adds no such protocol.

Connection opening, authentication and stored-page receipt have separate bounded
budgets: at most 30 seconds for the socket to open, 75 seconds for a required
NIP-42 challenge/signature/matching OK, then a fresh five seconds for the
stored-page query. Private queries start only after successful keeper AUTH.
Public checks without required authentication keep their finite page budget; an
unsolicited AUTH challenge does not extend it. An explicitly consented
auth-required public retry gets its own bounded AUTH phase and fresh page budget.
Consent withdrawal or phase expiry discards late signer replies and opens no
public fallback. These budgets allow supported signer waits; they do not resolve
the historic Cambium SDK stall or establish hardware/network acceptance.
