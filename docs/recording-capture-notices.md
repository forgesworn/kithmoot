# Recording capture notices

G11 requires everyone, including late joiners and people reading another room,
to know who is recording and what is captured. This is the notice and client
compatibility prerequisite. The PWA's [local video recorder](video-recording.md)
uses it for audio, gallery, speaker and screen-share-with-camera capture;
Android currently displays these notices but does not record a call itself.

## Wire contract

The existing signed `recording` op and its signature domain remain unchanged.
A new `recording-capture` companion binds the room, recording id, version,
capture layout, recording participant and recording device to the room
authority's signature. Valid layouts are `audio`, `gallery`, `speaker` and
`screen-camera`. The latter three describe video together with call audio.

The signing digest is SHA-256 over UTF-8:

```
kithmoot/v1/recording-capture:<roomId>:<version>:<id>:<capture>:<recorder>:<device>
```

Room, participant and device ids use canonical lower-case 64-character hex;
the recording id is 32-character lower-case hex. Versions are non-negative
JavaScript-safe integers. No display names or external image URLs are signed
into the notice. Names are taken from the existing room/profile presentation
and shown alongside a short key; they remain self-asserted labels.

Capture details are sent before the running notice, and both are reposted
every five minutes over the encrypted control channel. Details alone never
start a warning or stop one. They describe a running notice only when id and
version match exactly; stopped, older or different recordings cannot inherit
them. Invalid signatures are ignored. Missing, stripped or unsupported details
retain a broad warning that shared audio and video may be included.

The PWA and Android decode and display these details in the room and the
original call's dock, and explain them before a late join. There is no public
recording catalogue or third-party lookup.

## Older clients and video eligibility

`recordingProfile: 2` is an optional, encrypted roster capability stating that
the device's UI explains these audio/video notices. Only numeric 2 counts;
absent, malformed and unknown values do not qualify. Absent clients retain
their previous JSON shape. The capability is a client claim, not identity
verification or proof of somebody's consent.

The participant view exposes support per device, choosing the presence
endpoint carrying the call ahead of an idle tab. An updated device does not
qualify another device of the same person, and an updated idle tab does not
qualify an older call tab sharing its device key.

The video compositor must exclude camera/share tracks from endpoints without
this capability, with a visible explanation before starting and named
fallbacks in the export. Older clients still see the legacy recording notice
and can contribute audio under their existing warning. An external recorder
or modified client remains outside this app's control.

## Evidence and remaining work

The [additive fixtures](../vectors/recording-capture.json) contain four signed
capture notices and exact control encodings. Android copies the file verbatim
and verifies these signatures independently, including every bound field and
re-encoding. Existing `kithmoot-vectors.json` is unchanged.

Tests cover malformed metadata, authority/room/field substitution, independent
roster decoding, absent-client encoding, per-device and same-device-tab
capabilities, matching notice ids/versions, stale replays and stopped notices.
The real Chromium recording journey checks the named recorder and audio
capture description in another member's notice and the late-join dialog.

The local video implementation and its short browser export checks are
described separately. Native capture, physical acceptance and 45-minute
synchronised export remain required before G11 is complete.
