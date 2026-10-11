# Private room and project logos

G15 remains open. This branch introduces the image and protocol foundations,
the shared local crop editor, browser/desktop room overrides, owner project
editing, contextual inheritance and encrypted project companion journal.
Android parity, complete client recovery and physical
acceptance still need completion before the whole feature can be shipped.

## Images

`LogoImage` carries a static square PNG or WebP inline, capped at 256 pixels
per side and 16 KiB of encoded image bytes. It includes intrinsic dimensions
and a SHA-256 integrity hash. URLs, SVG, animation and embedded EXIF/XMP/ICC
metadata are rejected. Images are neither identity claims nor access proofs.

The editor decodes a local file, draws the chosen square crop onto a fresh
sRGB canvas and packages that new encoding. Browser canvas WebP encoders may
add an ICC profile, while WebKit falls back to PNG and adds EXIF to its fresh
canvas. `logoFromCanvasEncoding` removes ancillary chunks from
that freshly generated encoding before applying the strict reader checks.
Recipients must never use this repair on untrusted signed input. The container
checks are not a pixel decoder: renderers must handle local decode failures
with accessible initials and must retain the room or project name.

Format references: [PNG specification](https://www.w3.org/TR/png-3/) and
[WebP container specification](https://developers.google.com/speed/webp/docs/riff_container).

## Room overrides

An admitted writer can change a room logo on the same terms as the shared
room name. The small `logo` control operation names the ordering key and image
hash; the image travels in `roomLogo` inside the same credential-bound,
encrypted chat event. It is accepted only on the control channel, beside a
matching operation, without chat attachments, reactions, replies or other
statements. `null` deliberately removes the override and restores inheritance.
There is no extra relay, upload host or public image URL.

`RoomLogoBook` uses deterministic time/id/hash ordering. Old-epoch writes
stamped after the room-name rekey grace period are discounted. A current
member may carry the winning image or removal into a new epoch, retaining
its original ordering key without attributing authorship to the carrier.
Followers must attach before the first rekey, as room-name followers do.
Read-only logs cannot publish; closing a follower prevents further changes.

In the browser and desktop UI, Room details offers **Change room logo** to an
admitted writer in a regular room. The shared editor accepts local PNG, JPEG
and still WebP files up to 8 MiB/16 megapixels, inspects dimensions before
decode, then offers square crop, zoom and horizontal/vertical position. It
previews the fresh crop and supports cancellation, replacement and removal.
Closing during decode releases late bitmaps. A room/epoch change invalidates
the editing target before publication. Private/quiet conversations keep their
person identity treatment rather than offering room-brand editing.

Headers, the rooms list and the originating-call label use inline images with
initials on failure. The read-only room watch follows changes while the room
is closed without announcing another participant. Logos never change chat
activity or unread timestamps. Cached records retain their epoch; a cache
seed does not count as a live relay copy. Optional persistent thumbnails are
capped at 64 rooms without deleting admission records. Temporary and
self-destructing room thumbnails remain in memory, and forgetting/room cleanup
clears their cache and follower. These are local room-cache rules, not complete
account recovery or the anonymous no-history goal's acceptance.

Older clients ignore the unfamiliar control operation and keep reading the
room. The underlying credential, channel and circle primitives are unchanged.

## Project inheritance

Existing v1 project definitions reject unknown fields. Adding an image there
would cause older clients to discard the entire directory, including its
membership. Instead, owner-signed companion records use the separate
`kithmoot.project-logo.v1` domain and `logo:<project>` address. Delivery uses
encrypted NIP-44 wrappers to the project's current declared members.

A reader supplies its already-verified current directory. The record must
match its owner, project and current `projectAuthority` digest. A logo cannot
create membership, join rooms or change execution authority. Directory
authority changes invalidate old companions. The project directory journal
now stores companions, exact outgoing wrappers and immutable request receipts
under its existing encrypted cache and single-writer storage lock. Optional
new cache fields leave old v1 directory records readable; old clients continue
to ignore the companion domain. Logos do not create a personal project join.

Same-version conflicting owner edits withhold the image until an owner supplies
every observed logo head and resolves them at a higher version. A project edit
refreshes an unambiguous logo for the new authority in the same durable commit,
including membership and archive/restore changes. It never sends the refreshed
companion to a removed member. Old authority and superseded outboxes are
discarded; retries reuse the exact signed inner and encrypted outer events.

Primary and optional secondary relay deliveries require guards that recheck
the current directory, image and recipient before socket writes. Closing the
directory blocks late signing/publication. An unsupported primary carrier is
refused before asking the signer. The browser supplies a guarded secondary
inbox adapter: recipient relay lookup is checked before and after its await,
then the pool checks the same guard before delayed socket writes. Ordinary
directory delivery retains its existing behaviour. Complete disjoint-relay
browser delivery remains an acceptance gate.

A bounded queue keeps up to 128 encrypted companions that precede their project
directory. Without a verified member context, envelopes are not decrypted.
Once verified contexts exist,
one decryption selects the matching owner/project and validates its current
authority. The complete journal retains its 32 MiB source-byte cap, 1,024
outgoing-event and 4,096 receipt limits. Unit journeys recover logos/removals
and exact offline retries without relay history; browser account recovery and
Android parity remain separate acceptance.

Project cards offer **Change project logo** only to the owner of a ready,
unambiguous, unarchived project. The same local crop editor previews, replaces
and removes it. The reviewed project heads and all logo heads bind the save;
an account change closes the editor and blocks its old target. An owner may
also resolve a logo conflict by selecting a replacement or removing all
conflicting heads. Other declared members see the inline artwork on their
project invitation card without automatically joining the project or room.

The display rule is: room override, then the current joined project
context's logo, then a sole matching joined project's logo, then initials.
With multiple project contexts and no selection, initials avoid implying
ownership by an arbitrary project. Project cards, navigation headings, room
rows and headers use this context. Removing a room override restores its
inherited project image. A call captures its own selected project on joining;
changing the conversation or opening the same room from another project does
not change that call's context. Updates to its own project still propagate.
Pre-admission branding remains open: its implementation must use project
branding only when that project is already authorised and joined locally.
No logo bytes or new fields are added to bearer invitation links.

## Remaining acceptance

- Qualify disjoint-relay delivery and recovery in the complete browser client.
- Complete invitation/admission branding across client routes and account
  recovery, with Android editor/rendering and interoperable metadata handling.
- Qualify temporary-room expiry, invalid compressed pixel fallback and all
  permission/identity changes in the complete client journey.
- Add Android codecs and UI, with cross-client vectors and member/removal tests.
- Test light/dark, small phone layouts, invalid compressed pixels, permission
  changes, reload/recovery, cancelled editing and physical devices.

The initial protocol qualification passed 18 focused cases and all 3,905 unit
tests in 276 files. The room editor revision passes full typechecking and all
3,910 unit tests in 277 files, including real browser encoder fixtures for
Chromium's ICC and WebKit's EXIF. Twelve browser journeys pass across Chromium,
Firefox and WebKit: two admitted members share/crop/replace/remove, restore after
reload, receive changes while the room is closed without changing activity time,
cancel pending bitmap decoding, and use 320-pixel light/dark editors that reject
SVG and oversized inputs without external image requests. The existing call-dock
continuity journey also passes. The same four logo journeys pass against the
desktop build (16 logo journeys in total). The project journal revision passes
typecheck, 25 focused protocol/directory cases and all 3,922 unit tests in 278
files, including authority changes during delayed primary/secondary delivery,
conflicts, exact recovery, early envelopes, storage failure and late signing.
After reconciling current main, typecheck and all 3,938 tests in 279 files
pass. Twenty existing project journeys also pass across Chromium, Firefox,
WebKit and the desktop build, followed by packed library/agent imports.
Installed desktop and physical phone acceptance remain open. This is not an
installed or publicly shipped logo feature.

The project editor/inheritance revision passes typecheck and all 3,950 unit
tests in 281 files. Forty browser journeys pass across Chromium, Firefox,
WebKit and the desktop build, including real decoded project images, owner
editing and cancellation, member permissions, fresh-account encrypted relay
recovery, a shared room in two differently branded projects, room override
removal and 320-pixel light/dark layouts without external image fetches. The
call retains its original project name and image when the same room opens
under another project and when navigation docks it beside another room. A
separate Chromium call-dock journey passes with decoded live synthetic audio
continuity. These are automated browser checks, not physical device or
disjoint-relay qualification.
