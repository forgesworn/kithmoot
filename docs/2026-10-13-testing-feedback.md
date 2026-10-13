# Desktop and Boards acceptance feedback, 13 October 2026

These are delivery requirements from the user's hands-on testing. Publication
alone does not close a reported failure.

| Requirement | Current evidence | Remaining gate |
| --- | --- | --- |
| Delete a card directly, including starter cards; confirm with Y; Escape keeps it | Girnel source 2f2d741, visible Delete card control and keyboard confirmation; shared deletion and reload browser checks pass | Integrated browser and signed Mac checks pass; Published in desktop 0.1.79; user retest |
| A colour click survives a title save and persists | Girnel source 2f2d741 preserves the activated controls through pointer release; shared purple colour and reload checks pass | Integrated browser and signed Mac checks pass; Published in desktop 0.1.79; user retest |
| Pop out returns the main window to chat; closing the window leaves a discoverable board | Host room board links and account-scoped board navigation implemented | Integrated and signed Mac journeys pass; Published in desktop 0.1.79; user retest |
| A board created in a chat is shared with its people, rather than remaining on one device | Girnel source 85458a5 adds an explicit room sharing destination. New room boards complete normal board publication then publish their invitation into the authenticated encrypted room catalogue. Separate-person discovery, editing and reload pass in Chromium. The catalogue is encrypted to the account locally and members carry it to late joiners | Existing private board sharing and signed Mac checks pass; All 12 final web checks pass; published in 0.1.79; user retest |
| Entering a room shows latest messages; a new post is visible | Room entry/re-entry, delayed history, refused archive storage and sending checks pass in Chromium; desktop entry and sending pass | All 12 final web checks pass; published in 0.1.79 |
| Recordings contain the call's voices | Supplied recording decodes as silence. Simultaneous starts reproduced a silent gallery export despite received remote audio. Unrecorded starts now converge on the deterministic room call, preserving recording admission. Six remote-only browser exports pass, including simultaneous starts | Signed Mac remote-only exports pass in normal and simultaneous-start calls; All 12 final web checks pass; published in 0.1.79; user recording retest |
| Android and Mac deliver live video and audio | Connected Pixel runs 0.6.83 (106), capture permissions are granted and camera frames advance. Its offers to the M4 endpoint were retried without answers. M4 ran 0.1.77. User restarted all endpoints and reports calls work again | Preserve the stalled-handshake incident; do not attribute recovery to an unshipped code change |
| Pixel portrait camera remains portrait on desktop | Portrait presentation now fits decoded portrait dimensions. Real synthetic portrait-to-landscape WebRTC checks pass in browser and desktop variant | Published in 0.1.79 after all 12 web checks; physical Pixel acceptance |
| Chatting elsewhere retains a useful call gallery, speakers, shares and independent pop-outs | Docked calls default to equal gallery tiles and incoming shares retain the gallery. Both browser variants verify received audio, share pop-outs and sending in another chat | Signed Mac checked; Published in 0.1.79 after all 12 web checks; physical acceptance |
| A large desktop share fits on Android instead of appearing zoomed in | User confirms cropping in both views. The actual tile surface now fits decoded rotated frame dimensions; the expanded renderer initialises its texture aspect/buffer immediately. The 3840-by-1080 four-edge regression passes in both views and after replacing a zoomed share on the same track; existing drawing, zoom and platform PiP pass. Signed 0.6.85 (108) retains the 0.6.84 recording update | All 17 final Android checks pass; 0.6.85 merged and published on website/GitHub/Zapstore; physical Android retest |

Private user recordings and room invitations are excluded from this document.
Existing unrelated Android checkout changes and emulators are preserved.

The standalone Girnel web app is published from merged source `339268a`.
All 114 public assets, the manifest and security headers match the clean build.
Desktop deletion, purple colour and peer propagation checks pass, as do the
phone browser variants. One desktop colour reload assertion first saw the app
still opening; the unchanged case passes alone. This is recorded in
[evidence](evidence/girnel-board-feedback-publication-2026-10-13.json).

Desktop 0.1.79, web and Android 0.6.85 are published. The
[publication receipt](evidence/boards-call-feedback-publication-2026-10-13.json)
records all 12 web and 17 Android checks, notarised signed-Mac journeys, all
public web/installer hashes, APK certificate/lineage and signed Zapstore and
APT readbacks. This is delivery evidence; it does not replace physical user
retesting or imply that the existing private board was automatically
shared. Choose Share with this chat from its creating profile.

The release server's main volume reached 26 MB free. New APKs and web releases
now use `/opt/bulk/kithmoot-delivery-20261013` through the canonical directory
paths. Atomic exchanges preserved every old inode and checksum; no old file
was removed. Keep `apk-legacy-20261013` and `releases-legacy-20261013`: they hold
older public artifacts. The main volume still needs separate capacity work.
A local Docker cleanup interrupted unrelated containers briefly; the service
was restored immediately, and all 19 prior containers run without unhealthy
or starting health states. Those containers remain running.
