# Private room and project logos

G15 remains open. This branch introduces the image and protocol foundations,
the shared local crop editor and browser/desktop room overrides. Project logo
storage and editing, inheritance, Android parity, recovery and physical
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
authority changes invalidate old companions; the owner must republish the
desired logo for the new authority. Versions and immutable request IDs will
need a durable, locked outbox and conflict handling in the client store.

The intended display rule is: room override, then the current joined project
context's logo, then a sole matching joined project's logo, then initials.
With multiple project contexts and no selection, initials avoid implying
ownership by an arbitrary project. Pre-admission screens may use project
branding only when that project is already authorised locally. No logo bytes
or new fields are added to bearer invitation links.

## Remaining acceptance

- Wire the shared editor to authorised project controls.
- Implement locked project companion storage, conflicts, immutable retries,
  authority refresh and recoverable offline state.
- Implement project inheritance and navigation, and render admission branding
  only from authorised local state.
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
continuity journey also passes. The same four logo journeys pass against the desktop build (16 logo
journeys in total). Installed desktop and physical phone acceptance remain open. This is not an installed or publicly shipped logo feature.
