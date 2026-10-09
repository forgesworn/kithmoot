# Call-owned screen-share viewers

A share viewer follows the call's room session, participant, device and screen
role. Navigation cannot replace those with the room currently being read. The
window title and header show the sharer and original room, plus its project when
one is explicitly assigned. Project labels do not grant room membership.

The expanded modal is replaced when another share is opened. Popouts are
independent: opening or closing one does not close another or stop the sharer's
track. Each window plays muted video; audio remains on the call's existing audio
path. Its camera inset uses the same participant and device, can be hidden or
resized, and shows an explicit fallback when the camera is off.

Screen and camera track replacements are followed within that owner. If the
device leaves the call or withdraws its share, the viewer releases its video
source and explains what ended. Ending the owning call closes all its viewers
and forgets transient annotations. Reading another room keeps the call's
popouts, but dismisses its modal. Returning to the call does not rejoin it or
replace its running tracks.

The main stage refits a share when its first decoded dimensions arrive or its
shape changes, without waiting for a scroll or another roster update. Scroll
acceptance measures the decoded, fitted picture rather than its empty slot.

Drawing publishes through the owning call session, with room, call and share
checks at publication. A share from a different call or another device cannot
be substituted when the current source disappears. Marks remain transient.

Browser acceptance covers two simultaneous popouts, another-room navigation,
stable received tracks, marks reaching the original sharer, camera off/on and
hide/show, independent closing, sharer departure and share stop. A phone-sized
touch browser checks camera bounds, reachable controls and absence of horizontal
overflow. These are automated browser results, not physical phone acceptance.

This is the viewer foundation for product goals G13/G14. A persistent top gallery,
native Android parity and the named physical-device journeys
remain required before those goals are complete.

Manual [gallery paging](call-gallery-paging.md) has a separate stable call-owned
selection and pauses only its off-page video elements.
