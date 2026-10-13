# One captured ordinary storage image

`captureOrdinarySnapshotContext(browser, tab)` clones and physically validates
both complete reserved images and captures the actual startup location once.
The frozen capability exposes counts only. Validation compares every reserved
name, value and count, including revision signals and the tab marker. Unrelated
origin storage is outside this image. Every validation attempt consumes the
capability, including a failure; copied and explicitly released tokens hold.

The private consumer dispatches the captured family partitions to their strict
validators. Access, bookmarks and original startup/navigation links resolve
together. Validated root secrets derive stable room keys inside that closure;
conflicting roots, policies and explicit end times hold. Actual stored device
keys and signed credentials assign accounts to rooms. A dormant visitor key,
UI account reminder or caller-supplied key cannot supply that assignment.

Epoch v1 roots and v2 current/history secrets remain bound to their physical
room/account namespace. Epoch zero comes from the actual retained room secret.
Identical epoch-zero roots are deduplicated; the consumer never selects the
highest epoch or guesses a named channel. Historical checks use the signed
message time, preserving expired credentials and queues without pruning.
Retained history departure timestamps do not impose a new send-time cutoff.

Pending queues finish structural/signature, capacity and duplicate checks for
all queues and both owners before any binding callback. Each callback receives
the actual physical owner. The complete-image callback authenticates and
decrypts the inner message, validates its embedded credential, and binds its
account, room, device, channel, time, display ID, text, files and artwork.
Canonical writer JSON and equality with the normal decoder's result prevent
duplicate keys, unknown fields and silent repair or deletion of optional fields.
Inner IDs use the PWA writer's exact 32 lowercase hex format; referenced
historical IDs retain the message codec's separate grammar.
Event tags must be the exact derived channel tag plus the expiration when an
explicit retained room end exists. Missing or extra expiration holds rather
than guessing whether an older message predated that end. These are historical custody checks,
not permission to restore, publish or retry.

The pending producer checks distinguish the PWA's durable ordinary main-chat
composer from transient named/quiet messages, invitations, reactions and
retractions. Editable rows cannot claim files, replies, edits or statements.
Agent-only transcript, assignment and room-logo messages have no PWA pending
producer. The quiet reload writer omits attachment/artwork display labels; its
exception requires an exact matching event in independently validated browser
quiet custody under that account, room and protocol epoch.

Quiet counter participants must match the exact captured device/account owner
and belong to the retained room policy. Legacy counter-only and epoch records
also require actual legacy device/credential evidence. Queued
events need the actual outgoing device and exact protocol epoch. The source's
fixed `assignments` and `control` channels can bind independent quiet queues;
assignment envelopes must carry a valid authenticated assignment and its exact
operation label. Control text must round-trip through the strict canonical
control shape; logo operations also need their matching inline image/removal.
Control messages remain inert custody and confer no control authority. Other named
channels can be proven by successfully bound pending ciphertext in the same
image; an otherwise unknown dynamic channel holds. Empty counter dictionaries still
require room/epoch evidence. Raw cadence records need separately authenticated
node/grant evidence that this image does not contain, so they hold.

Assignment journals are decrypted with the stable room key inside this closure.
History requires exact canonical signed assignment events, with no duplicate
IDs. Outbox entries require exact canonical `{inner,outer}` pairs, unique request
and outer IDs, the captured account/device and a retained historical epoch.
The outer's embedded assignment must byte-match its inner. Every persisted
quiet assignment event must then byte-match exactly one same-account/room
outbox outer under the quiet row's explicit epoch. Journal-only cuts remain
valid before queueing or after queue removal; history can already contain the
pending inner after a relay echo. None of this proves current assignment
permission or allows execution/republication.

This module is not mounted in production startup. Its family dispatch proves
captured custody structure and the described message bindings; it does not
prove all cross-family authority. Opaque carrier authentication, signer-backed
bookmark decrypt/compare, fresh admission/channel permission, cadence authority,
the raw preflight before native owner allocation, protected independent-module
startup, real client/capacity fences, awaited effects and coordinated forgetting
remain required. No DG08, complete runtime, release, physical acceptance or
independent continuity claim follows from this checkpoint.

Fixtures use the real room, device, credential, epoch, ChatLog, PendingSends,
quiet transport and storage writers before the no-effect probe. Native tests
run the private consumer on actual captured Storage/location in Chromium,
Firefox and WebKit while blocking clocks, entropy, key allocation, encryption,
IndexedDB opening, storage writes and networking. They verify source bytes stay
intact on success and hold. They remain bounded component tests, with no mounted
app root, fresh signer authority, external peer delivery or handset acceptance.
