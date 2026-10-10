# Manual call gallery pages

The call gallery uses a bounded page: at most nine tiles on a desktop stage,
two participant cards on a narrow phone, and four on a wider touch layout.
Desktop capacity also follows the measured stage dimensions. Camera-off members
keep their named tile. Phone cards combine a member’s camera and screen; desktop
screens have their own gallery tile.

Previous/next controls show the page and total tile count. Keyboard navigation
supports arrows, Page Up/Down and Home/End within the page control. A horizontal
touch swipe across a camera/card changes the page; buttons, screen drawing and
the draggable self-view retain their own gestures. Controls are at least 44px.

A call owns its page, stable participant/share order and pin. Roster reorder and
new arrivals do not reorder existing members. A resize or departure retains a
surviving tile from the selected page. Another call starts with fresh selection.
The speaking line identifies speakers outside the selected page without making
the manual gallery follow them.

Off-page gallery video elements pause. Their received tracks, audio and separate
share-viewer video sinks continue. Returning resumes the original gallery video;
video recovery must not diagnose the deliberately paused clock as a frozen
picture. This limits unnecessary gallery playback, but makes no measured battery
or network-saving claim.

Validation covers the pure ordering/layout model and real browser audio/video
on desktop and a touch-sized phone. Two real synthetic-media participants plus
24 layout stand-ins exercise paging: audio energy and popout playback advance,
the hidden gallery camera pauses, and returning retains its original element
and track. Existing call docking, layouts, viewer and annotation checks pass.
Stand-ins do not qualify a 26-person encoded-media call.

This implements the gallery paging portion of G12 and the off-page playback
portion of G10. Physical battery measurements, room-capacity qualification,
speaker-view scale and native Android parity remain open. The browser
[persistent call surface](call-surface.md) keeps the gallery visible across
conversation navigation; G14 still requires physical and native acceptance.
