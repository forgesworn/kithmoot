# Cameras across a person's devices

The PWA rendered placeholders for a person's other cameras but Mesh refused to
open media connections to any device with the same participant key. Mesh now
excludes only the exact local device. A subsequent Android audit found the same
exclusion in RoomSession, plus rejection of incoming sibling signals; the
separate Android update removes both exclusions. Existing participant grouping, audience restrictions and local audio
muting still apply, so a paired camera appears in the person's tile without
playing their other microphone back to them.

Validation on base 97c1866:

- 1,904 unit tests passed, including updated mesh/session expectations.
- Three independent Chromium contexts: two paired devices and a third person.
  Each paired device displays both its own and its counterpart's moving video;
  the third person receives both pictures. Sibling audio remains muted and
  exactly one paired device plays the other participant's audio.
- The same browser test passed against the public PWA and live relays.
- Deployed release: 20260916T100810Z. Public index.html and sw.js match the local
  production build byte for byte. Public Android download was not changed.

This is synthetic Chromium evidence, not physical iPhone or Pixel acceptance.
Existing open PWAs need to load the update before they use the changed mesh.
Android's separate missing remote video remains a physical acceptance gate.


## Mobile call and long text follow-up

The mobile room has separate Call and Chat views. Chat keeps the existing call
connected. Call uses the available screen for the video grid and keeps the
primary controls at the bottom; settings open in a sheet. Keyboard height uses
the visual viewport, and portrait/landscape layouts are checked separately.
Media holders label this device and other devices without replacing players.

The composer no longer uses maxlength to silently cut a paste at 2,000 UTF-16
code units. Send converts larger text into an encrypted text attachment with a
short caption, retaining the original whitespace and Unicode in the document.
The existing file-store consent and 256 MiB upload ceiling still apply. Upload
failure preserves the original draft. Switching channels or editing during an
upload never sends a different draft. Native clients can read the short caption;
native attachment opening remains a separate gap.

Long messages and decrypted text documents offer Read more and Copy. Copy uses
the complete text, not the preview. Message actions can prepare a task or summary
assignment with an exact source message ID, author and channel. The user chooses
and shares the assignment; it remains offered until an agent accepts it.

The MCP agent adapter adds chat_read_source, which verifies source membership,
fetches and authenticates its encrypted text attachment, and returns explicit
pages with nextOffset. Attachment reads are bounded at 8 MiB and 30 seconds.
Existing running agents need this updated adapter; no model or agent is silently
started by the PWA. Unavailable source material must be reported as blocked.

Validation: 1,906 unit tests passed. Chromium acceptance covers the full encrypted
text round trip beyond 64 KiB, expand/copy, upload failure and draft edits, plus
three-device moving cameras. Clipboard tests use an isolated browser stub and do
not alter the operator's clipboard. Physical iPhone keyboard, playback and
clipboard acceptance remain required.


Follow-up PWA release: `20260916T110444Z`. The public index and service worker
match the local production build byte for byte. Five focused Chromium browser
checks pass: task source/draft preservation, long document expand/copy, upload
failure/edits, phone reading/accessibility, and portrait/landscape Call/Chat.
The WebKit runner failed before app navigation: even a fresh blank page timed
out after 20 seconds. No WebKit or physical iPhone pass is claimed.

Android sibling candidate: `1e7d11a69227226082de01c7ce2d556504d3148846fa93cd2e465e93642d7ee2`.
391 tests plus release build and lint pass. The checksum-verified handoff is at
`~/kithmoot-sibling-camera-20260916` on M4 and awaits the operator's signature.
This supersedes the earlier installed video update for paired-camera support.

The paired-camera test also passed against public release `20260916T110444Z`
with live relays (19.9 seconds): both paired browsers display both moving cameras,
the third person receives both, and sibling audio remains muted.
