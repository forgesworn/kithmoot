# Private room and project logos

G15 remains open. This branch introduces the image and protocol foundations;
upload/crop controls, client storage, rendering, Android parity and physical
acceptance are still required before the feature can be shipped.

## Images

`LogoImage` carries a static square PNG or WebP inline, capped at 256 pixels
per side and 16 KiB of encoded image bytes. It includes intrinsic dimensions
and a SHA-256 integrity hash. URLs, SVG, animation and embedded EXIF/XMP/ICC
metadata are rejected. Images are neither identity claims nor access proofs.

An editor must decode a local file, draw the chosen square crop onto a fresh
sRGB canvas and package that new encoding. Browser canvas WebP encoders may
add an ICC profile; `logoFromCanvasEncoding` removes ancillary chunks from
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

- Wire the shared editor to authorised project and room controls, with crop,
  preview, replace/remove, clear failure feedback and sensible file limits.
- Implement locked project companion storage, conflicts, immutable retries,
  authority refresh and recoverable offline state.
- Render logos in navigation, headers and originating-call labels with names
  intact; render admission branding only from authorised local state.
- Keep temporary no-history logos in memory and delete retained room assets
  on expiry, forgetting and private-history removal.
- Add Android codecs and UI, with cross-client vectors and member/removal tests.
- Test light/dark, small phone layouts, invalid compressed pixels, permission
  changes, reload/recovery, cancelled editing and physical devices.

The initial qualification passed 18 focused image/project/room cases, full
typechecking and all 3,905 unit tests in 276 files. This establishes protocol
behaviour in the simulator, not an installed or publicly shipped logo feature.
