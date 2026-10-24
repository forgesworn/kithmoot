# Public Spry and physical GrapheneOS call qualification

24 October 2026. Qualification of Spry with KithMoot WebRTC, not the
RelaySwarm/Sapflow real-time integration or a production release.

The source snapshot was `5fd0ee4347bcc231c27e8b4bf838d72db9a0ab39`
plus the relay-check correction and public-call fixtures accompanying this
report. The server used pinned Spry source
`a76496bbcb60e637c0606c8da5919b5a3b2b3cf3`. Native acceptance used the
already installed Android 0.6.108 (version code 131), with no APK replacement.
No Android source was changed. Hosted CI was not run for this increment.

## What passed

The final M4 browser run passed all three cases without retries or skips in
34.523 seconds: UDP one-to-one, TCP one-to-one and trusted TLS one-to-one
followed by a three-person group. The TLS case also checked protected area
cropping/redaction, hide/resume, cover on source change until confirmation,
continued calls after sharing, and two rejoins. Every peer needed fresh
decoded video, decoded audio energy and advancing product playback clocks.
The nominated candidates were relay/relay with the expected transport.

Profiles were imported through product settings, separately for each
participant. The real Hide IP preference was enabled. Signalling was an
offline loopback relay; media used the external operator's Spry instance.
Loopback HTTP supplied a secure browser context with no certificate bypass.
HTTP/WebSocket requests outside loopback were refused. Credentials and TURN
endpoints were checked absent from the room link. Browser media was generated;
this did not exercise a real OS screen/window picker or multiple client WANs.

The physical GrapheneOS phone subsequently exchanged video/audio with the
browser using **native TURN/TCP and browser TURN/TLS**, with independent
temporary credentials. The browser decoded 3,107 phone video frames and
9,412,800 audio samples at the final acceptance snapshot. The owner answered
**“Yes, picture and sound”** when asked about the picture and test tone on the
phone. The ephemeral test user had no Google Play packages. The app's real
camera and microphone were used; no camera frames or recordings were saved.
These observations establish this call, not general call reliability.

The temporary Android user was removed and owner user 0 restored. Existing
users, app data and the pre-existing emulator were preserved.

## Correction and remaining failures

The device relay checker formerly waited for ICE gathering to finish on both
peers before exchanging descriptions. A usable relay can be found while
other configured candidates keep gathering. The checker now trickles ICE,
queues candidates until the destination has a remote description, and keeps
its existing deadline, relay-only policy and bidirectional echo check.
Four regression tests cover pending gathering, direct-pair rejection, abort
cleanup and generic candidate failure. The focused suite passed 43 tests;
type checking and the production PWA build passed.

Before that correction, UDP checks timed out. An earlier three-person TLS
run also lost a media pair on rejoin; a later local repeat passed. No product
rejoin fix was made. The first Mac was heavily loaded, but that does not prove
load caused the failure. The final complete run used the less loaded M4.

**Native TURN/TLS remains open.** The native phone produced no relay candidate
with either the original trusted certificate or a separately issued trusted
RSA chain. Browser TLS worked. A string scan of the installed WebRTC binary
did not find the tested ISRG root names; that is a trust-store lead, not a
confirmed cause. No certificate validation was disabled. The original
certificate was restored and the temporary certificate lineage removed.

## Combined-stack boundary

The intended stack remains **Spry + RelaySwarm + Sapflow**, as described in
[the combined assessment](combined-call-transport-20261023.md). These results
qualify only Spry/WebRTC. RelaySwarm's existing HLS rendezvous/transfer code
and Sapflow's compressed-media broadcast libraries are not connected to this
call path. They do not yet supply the encrypted real-time group forwarder.

The next experiment is a bounded real-time adapter: reuse actual RelaySwarm
peer/rendezvous primitives and Sapflow queue/media primitives, keep media
keys with participants, and forward through an independently selected
operator with Spry providing reachability when needed. Compare sender upload,
latency and loss at 2, 4 and 8 participants and test forwarder replacement.
Do not route conversational media through HLS by default or describe its
ordered reliable segment transport as an existing SFU.

Independent operation and absent persistent call logs remain design
requirements, not proof of an Online Safety Act exemption. The application
of the law to the combined offering remains unresolved in the existing
legal-cover assessment. No public directory or credential issuer was added.

Sanitised numeric results are in
[`public-call-qualification-20261024.json`](../evidence/public-call-qualification-20261024.json).
Private profiles, room links, raw UI dumps and the pulled APK are temporary
qualification artefacts and are removed after this report is recorded.
