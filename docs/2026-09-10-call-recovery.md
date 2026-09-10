# Detached receiver recovery

Chromium CI run `34424823277`, job `102707702861`, failed the existing
`test/media.spec.ts` recovery check: after a remote video element was removed,
no picture returned within ten seconds. The other 112 Chromium tests passed.
The same failure reproduced in one of three local runs.

Removing the element can pause playback. Appending that existing element
again does not reliably restart autoplay. Recovery now explicitly resumes
an element that left the document, while normally parked elements retain
the existing stall rules. A receiver already bound to an advertised track
also keeps that binding when its browser-issued id differs from the sender's
id; otherwise a later reconciliation could incorrectly treat it as orphaned.

Pausing and removing the receiver element reproduced the failure before the
repair. The final acceptance test also models a distinct receiver id and
requires resumed playback plus moving pictures and received audio. That
expanded test passed three consecutive Chromium runs after the repair. Type checking passes. Full hosted
browser checks remain required; this is browser acceptance, not physical
phone or VPN/TURN certification.
