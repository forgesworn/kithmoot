# Desktop and Boards acceptance feedback, 13 October 2026

These are delivery requirements from the user's hands-on testing. Publication
alone does not close a reported failure.

| Requirement | Current evidence | Remaining gate |
| --- | --- | --- |
| Delete a card directly, including starter cards; confirm with Y; Escape keeps it | Girnel source 2f2d741, visible Delete card control and keyboard confirmation; shared deletion and reload browser checks pass | Integrated browser and packaged desktop checks; publication |
| A colour click survives a title save and persists | Girnel source 2f2d741 preserves the activated controls through pointer release; shared purple colour and reload checks pass | Integrated browser and packaged desktop checks; publication |
| Pop out returns the main window to chat; closing the window leaves a discoverable board | Host room board links and account-scoped board navigation implemented | Integrated close/reopen/reload journey; packaged desktop and publication |
| A board created in a chat is shared with its people, rather than remaining on one device | Girnel source 85458a5 adds an explicit room sharing destination. New room boards complete normal board publication then publish their invitation into the authenticated encrypted room catalogue. Separate-person discovery, editing and reload pass in Chromium. The catalogue is encrypted to the account locally and members carry it to late joiners | Final clean package checks, existing private board sharing, desktop, publication and user retest |
| Entering a room shows latest messages; a new post is visible | Room entry/re-entry, delayed history, refused archive storage and sending checks pass in Chromium; desktop entry and sending pass | Final source CI and publication |
| Recordings contain the call's voices | Supplied recording decodes as silence. Simultaneous starts reproduced a silent gallery export despite received remote audio. Unrecorded starts now converge on the deterministic room call, preserving recording admission. Six remote-only browser exports pass, including simultaneous starts | Mac packaged export, final source CI and publication; user recording retest |
| Android and Mac deliver live video and audio | Connected Pixel runs 0.6.83 (106), capture permissions are granted and camera frames advance. Its offers to the M4 endpoint were retried without answers. M4 ran 0.1.77. User restarted all endpoints and reports calls work again | Preserve the stalled-handshake incident; do not attribute recovery to an unshipped code change |
| Pixel portrait camera remains portrait on desktop | Portrait presentation now fits decoded portrait dimensions. Real synthetic portrait-to-landscape WebRTC checks pass in browser and desktop variant | Final source CI, publication and physical Pixel acceptance |
| Chatting elsewhere retains a useful call gallery, speakers, shares and independent pop-outs | Docked calls default to equal gallery tiles and incoming shares retain the gallery. Both browser variants verify received audio, share pop-outs and sending in another chat | Final source CI, packaged desktop and publication; physical acceptance |
| A large desktop share fits on Android instead of appearing zoomed in | User confirms cropping in both the small call tile and expanded viewer. Android already requests fit for share tiles. A separate isolated correction resets new-share zoom and initialises the texture renderer's aspect and buffer dimensions; a 3840-pixel four-edge rendering regression is being qualified | Reproduce both views, Android CI, signed APK publication and physical Android retest |

Private user recordings and room invitations are excluded from this document.
Existing unrelated Android checkout changes and emulators are preserved.
