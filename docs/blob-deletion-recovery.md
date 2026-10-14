# File deletion custody and recovery

This local checkpoint repairs file cleanup before the remaining ordinary-state
custody families are integrated. It does not complete protected browser startup,
private Bothy files, independent admission authority or the release gate.

## Exact target permission

New `buildDeleteAuthorisation` events retain the BUD-02 tags and add the
app-domain `kithmoot-delete-target-v1` tag. It signs the exact canonical HTTPS
origin, port and hash path. Pass the optional fifth argument for a server below
a path prefix; the default is the origin's root hash path. The portable
`deleteBlob` helper deliberately refuses old unbound events, extra JSON event
properties, ambiguous tags and a mismatched URL before fetching. This is an app
extension, not a claim that generic BUD-02 servers enforce exact URL binding.

Existing pending journals lacking the signed target are retained byte for byte
and held even after their copied expiry. They are never automatically upgraded
by a newly signed permission or treated as empty. Recovery needs authenticated
original target provenance and explicit review; expiry cannot recover missing
provenance. New exact-bound journals require the whole canonical JSON array,
unique URLs, exact row/event shapes, verified signatures and copied signed
expiry. Both status and retry use the same parser without filtering damage.
The parser takes no clock and performs no network or Storage effects.

## Preparation before effects

An unsigned per-room upload record supplies candidate data only. The actual
app passes only its currently consented shared-storage origin, plus historical
kind-1063 announcements. The deletion function independently verifies those
announcements against the room device key, and grants permission only to the
exact URL/hash tuple they signed. One verified path cannot authorise another
unsigned path on the same operator. Upload records distinguish URL/hash pairs,
including the same hash on multiple operators.

Before sending any file request, cleanup signs all long-lived exact-target
permissions, reserves the entire pending journal (at most 2,000 rows and 8 MiB
of actual UTF-8 JSON), writes it and reads back the exact bytes. Capacity or
persistence failure stops file requests. Confirmed cleanup removes only the
exact row fingerprint sent, retaining a newer same-URL permission. It cannot
replace another uploader's retained same-URL permission. These synchronous
Storage operations are not a cross-tab transaction or anti-rollback proof;
protected-root and client-version coordination remain required.

DELETE acceptance alone does not confirm absence. Only HEAD 404/410 removes a
permission after a request; HEAD failure, abort or continued service remains
pending. This establishes absence at that response, not permanent destruction
or removal of third-party copies. Only structurally verified new permissions
may be pruned after expiry during retry.

If file preparation or final cleanup throws, or any target is refused, tidy-up
pauses before account cleanup and local key deletion. Its report states that
local room keys and upload records remain; it does not claim no earlier relay
or file effects occurred. Automatic self-destruction also reports failure rather
than claiming a completed wipe. A prepared retry can survive an unavailable
server without retaining the room key, preserving the ordinary offline path.

## Verification boundary

Unit tests cover initial and retry effects, exact-target tampering, malformed
whole journals, cached verification tampering, signed historical provenance,
count/byte capacity, quota/readback failures, expiry and concurrent replacement.
The native retry harness exercises actual source modules with native Storage
and fetch, using mocked HTTPS routes. The built-PWA harness drives real create,
upload and tidy-up controls against a local relay/Blossom companion in Chromium,
Firefox and WebKit, including paused cleanup with retained keys. Neither harness
performs a real remote deletion, measures real origin quota exhaustion, proves
independent operator behaviour, or supplies handset acceptance.
