# Persistent call surface

The browser call stage and dock live in a permanent surface beside the route
panels, inside the workspace. Switching to another room or home changes the
surface's layout; it does not move its media elements into another panel or
replace received tracks. Fullscreen includes both the surface and conversation.

When reading another room, the gallery becomes a bounded top panel. Its header
names the call's original room and explicitly assigned project. Its manual page
and pin stay owned by the call; a compact desktop fits the same selected page.
Phones have a compact gallery and a collapse control. Collapsing pauses gallery
video sinks while audio and independent share popouts continue.

Microphone, camera, screen sharing, recording and Leave use the original call
session. Another room's routing settings or recording authority cannot replace
that owner. Recording confirmation names the original room, its notice goes to
that room, and the resulting local file can be shared only from that room.

The room's end timer moves with the retained session and survives navigation in
both directions. Expiry or signed closure stops the owning call, recording,
media and popouts without leaving the conversation currently being read.
Self-destruction also discards that room's pending recording, including a clip
still finalising, and runs the existing authoritative local/relay tidy-up.
A cross-tab device-key wipe stops that room's retained call too.

Browser acceptance exercises three real synthetic-media clients, two live
popouts, A's call while reading and writing B/C, home and return, selected pages,
collapse/expand, original-room screen sharing and recording, and Leave while
recording. Desktop paging uses seven camera-off layout stand-ins which survive redraws;
these are not additional network or encoded-media clients. Separate
clock-controlled checks cover retained-history expiry and self-destruction while
another room stays open. Existing layout, divider and fullscreen checks cover
the moved measuring container.

This implements the browser persistent-surface portion of G14. Native Android
parity, physical phone/desktop acceptance, real project-switching journeys and
capacity/battery qualification remain open. See [gallery paging](call-gallery-paging.md)
and [viewer ownership](call-viewer-ownership.md).
