# Admin2 private storage withdrawal (development candidate)

This candidate does not enable production Admin2. Use the existing outer MLS
preview plus exactly one invitation preview; the Admin2 controls require the
explicit development-only Admin2 flag. No room keeper, MLS role or membership
Remove is created by storage authorisation or withdrawal.

## Protected records and authority

`kithmoot.storage-grants.v1` is a separate protected persona object, written
through the existing witnessed persona coordinator. It retains exact signed
kind-24242 active and terminal statements before publication, the issuer,
member persona/device, node and saved route, expiry of at most one hour,
revision, acknowledgement state and explicit storage withdrawal approval.
Signed terms reuse the existing event-grant wire. Empty room duties are
intentional: this ledger conveys storage authority only. Terminal history is
retained. A new active statement cannot reactivate a withdrawn grant.

Revision zero means prepared and unpublished. Installing/revoking means the
acknowledgement is unknown. Only the selected authenticated node's matching
OK and a subsequent witnessed save mark active/revoked. Retries send the
exact retained active or terminal event. An interrupted save or missing route
never proves access ended; local expiry alone is not a remote withdrawal ACK.

`kithmoot.admin-storage-requests.v1` separately pins prepared request operations
to the independently entered storage keeper, exact saved route/node, current
transmitting device and exact signed inbox permission. Preparation runs inside
the actual Admin2 host transaction, with the witnessed native roster and
current local credential. It requires a committed, unexpired, same-person,
nonlocal device whose home is the selected node. The native own leaf must
uniquely match the current credential/device and persona, be committed and
unexpired, and have that node as its home. Both binding expiries are checked
for preparation, replacement and fresh private sending. A permission's valid
signature alone does not establish the intended storage keeper. Self,
pending, absent, conflicting-person or wrong-home targets are refused.

The existing sealed request wire, private outbox, device AUTH consent and
private keeper inbox transport are reused. `kithmoot.storage-inbox.v1` stores
storage seen IDs, prompts, scan budgets and cursors separately from legacy
intake, using the existing strict inbox schema under its own protected object.
A legacy check cannot consume or advance storage intake, in either order. Prepared Admin2 operations refuse
public delivery and substituted destinations before request crypto or network;
a private failure never falls back.

An explicit replacement flow rechecks the native roster, current credential
and independent keeper pin, then compares both binding and outbox request
revisions. It retains previous exact signed permissions, destinations and
attempt observations. Sends share an operation lock; preparation/rebinding
holds it exclusively until actual settlement, so an in-flight send cannot be
overwritten. Afterwards the user chooses an explicit fresh private request
revision. Completed or expired attempts can repeat this way. The protected
object retains up to 16 replacements and 64 attempts per operation (and a
512 KiB overall bound), refusing further work without silently pruning
history. Expired wrapped-attempt evidence is archived before legacy expiry
pruning. Replacement never silently sends, changes keeper or falls back. Legacy grant records keep their existing schema. Shared grant custody gains
an explicit critical payload **v3** with a separate `storageScopes` field.
Storage preparation/publication holds the existing device admission gate
exclusively; protected custody checks exclude live or unknown legacy scopes.
Legacy admission, persistence and carrier publication exclude storage scopes,
including preserved historical storage records before a scope fence existed.
An expired storage grant cannot publish its terminal into a newly live legacy
scope. Exact frozen a10 v2 custody decoding refuses v3, so old writers cannot
ignore it. Scope history is retained and the envelope never automatically
downgrades after withdrawal or expiry.

`kithmoot.admin-storage-outbox.v1` holds Admin2 observations and attempts wholly
separately from legacy standalone state. A frozen a10 public reader cannot
find a new Admin2 operation. Only canonical pre-isolation observations with the exact one-node and
recorded one-source-session mapping are moved atomically under the persona witness, preserving attempts and all
other legacy entries. Existing binding, permission and attempt history is
retained. Source-less or aggregated observations, unsupported forms and differing
isolated collisions preserve all
original shared fields behind a critical membership v2 recovery fence; the
old reader refuses it before public discovery or crypto. No data is silently
discarded, reset or automatically downgraded. Ambiguous fenced data requires
explicit supported recovery.

New bindings retain the actual native source session and target leaf. A
recovered binding without that source must be explicitly rebound through the
actual room before sending; a session is never inferred from request hints.
The concrete owner reopens the witnessed Admin2 roster before reserving a
private attempt. Current Admin2 room operations share an origin-wide room
operation gate, held through private send settlement, while current-account,
credential, own-leaf and target-leaf expiry guards remain live at network
boundaries. This is local current-candidate coordination, not a claim about
unobserved remote commits or older room implementations.

Storage intake matches the keeper's own exact issued storage grants. It does
not open any legacy keeper room or infer storage authority from Admin2 roles.
The operator reviews the exact active/terminal IDs and revision, explicitly
approves storage-only withdrawal, and retries that frozen approval as needed.
This never invokes a membership removal API. Current native Admin2 admins
remain solely responsible for a separately chosen MLS Remove.

## Development panel journey

1. Prepare the account, witness and actual enrolled devices through the
   existing account and room panels. Pair the dedicated grant connection.
2. On the storage keeper account, select the saved node route and authorise
   the enrolled persona/device. Read protected storage grants after any
   interrupted result; retry the retained exact installation if needed.
3. Issue/install an inbox deposit permission for the requester's *sending*
   device and pass its ordinary signed JSON privately to that account.
4. On the requesting account select the actual saved Admin2 room and route,
   read actual device leaves and select the other committed device. Paste the
   signed permission and independently enter the expected storage keeper.
   Prepare the witnessed storage request, inspect the permission, then send
   privately with the explicit transmitting-device AUTH prompt. If the permission
   expires or is withdrawn, obtain an installed replacement from the keeper,
   use “Review replacement private permission / route” and explicitly retry
   at the current revision.
5. On the storage keeper account allow identification to the selected Bothy,
   check storage requests privately, review the exact grants and explicitly
   approve storage withdrawal only. Retry retained approval from protected
   storage grants after any unknown result.
6. The panel reports acknowledged storage withdrawal and **MLS membership
   unchanged**. Use the separate Admin2 room controls if a current native
   admin also intends to remove a member.

The named development controller exposes storage records, preparation,
private sending/checking, review/approval and exact approved retries; signing
consent still uses actual panel confirmation. These controls do not establish
physical or mixed-client acceptance.

## Evidence boundary

Focused offline tests cover durable-before-publication custody, failed ACK and
exact retries, stale revisions, independent keeper/route/permission/transmitter
bindings, refused roster targets and a complete sealed-request intake through
explicit storage-only approval/withdrawal without opening any MLS room.
Concrete private-endpoint regressions verify failed private delivery cannot
switch an Admin2 request to public discovery/publication.

Frozen compatibility tests run the pinned a10 outbox/state source and exact
v2 custody envelope decoder, with fixture hashes recorded beside the sources.
They cover clean isolation, historical migration and critical recovery fences.

The actual selected-node mixed browser/Android lab journey, native witnessed
request preparation and both storage/membership postconditions still require
acceptance with this exact candidate. Unit tests and type checks are not that
acceptance. Nothing here was published or deployed.
