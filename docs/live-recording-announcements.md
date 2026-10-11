# Live recording announcement candidate

Recording currently sends capture details and On every five minutes through
quiet chat. Eight drop keys per device per hour cannot support that cadence
alongside chat. Live presence already travels outside that budget.

Recording profile 3 adds `liveRecording` to presence. Its `recording` member is
the existing authority-signed recording control operation. On also requires a
`capture` member containing the signed capture operation with the same id and
version. Off has no capture member. Both signatures verify against the room's
pinned authority; a presence signature is not recording authority. Unknown,
incomplete and mismatched state is discarded. Profile 2 and missing fields
retain their existing encoding.

The independent codecs pass 446 Kotlin protocol tests, 49 focused TypeScript
tests and library/app type-checking. These are codec checks, not call runtime
or quiet-room capacity qualification. Neither client advertises profile 3 yet.

Remaining integration must publish and confirm the exact live state, consume
verified announcements through the ordinary recording warning UI, require
compatible call participants before capture, and stop or exclude media before
an incompatible device can enter a recording. Join, refresh, cancellation,
Stop, process recovery and rekey need cross-client runtime evidence. Existing
quiet Send/delegation and physical recording gates remain separate.
