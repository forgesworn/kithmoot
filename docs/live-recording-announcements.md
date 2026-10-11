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

Verified announcements now feed the native meeting warning and the web active
or docked call warning. Reception rejects conflicting same-version states and
older On replays after Off; the web getter returns an isolated snapshot. Native
receiver/meeting/session checks passed 61 tests, and focused web checks passed
120 tests with library/app type-checking.

Both session implementations now have an explicit guarded publication API.
The web API requires an acknowledged guarded carrier, isolates the signed input,
and checks ownership, admission, credential expiry, presence freshness and room
generation at dispatch and after acknowledgement. Quiet presence forwards this
guard without queueing or spending counters; chat and public file announcements
cannot use that bypass. Unsupported carriers fail closed. Ordinary call recording
still uses the existing path and does not advertise profile 3.

The latest web checks passed 193 tests with library/app type-checking, including
the guarded WebSocket and room-route regressions. Simulated 45-minute refreshes
spent no quiet counters. Rekey clears outgoing On, invalidates queued warnings,
and cannot turn the publisher's own echo into acknowledgement. These checks are
not physical capture or cross-client runtime qualification.

Remaining integration must connect confirmed live publication to capture, require
compatible call participants before capture, and stop or exclude media before
an incompatible device can enter a recording. Join, refresh, cancellation,
Stop, process recovery and rekey need cross-client runtime evidence. Existing
quiet Send/delegation and physical recording gates remain separate.
