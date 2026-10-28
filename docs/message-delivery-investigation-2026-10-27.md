# Message delivery investigation, 27 October 2026

Tester report: messages appear not to arrive and mobile-to-desktop history is
unreliable, including after reopening. The owner reports current client
versions. Conversation type, event IDs, relay responses and the sending phone's
post-restart history have not been established. The defects below are
reproduced code paths, not a confirmed attribution of the tester's messages.

## Web and desktop: expired sending credential

`ChatLog.prepare()` could sign and publish a new chat message after the device
credential expired. A relay could acknowledge the ciphertext, allowing the
outbox to clear it, while `decodeChatEvent()` correctly refused it on every
reader. Relay acceptance therefore appeared to be a successful send of a
message that could never enter the conversation.

Preparation now verifies the credential at the exact message timestamp before
returning a prepared send. The existing composer catches that failure before
clearing its draft. Normal credential renewal enables sending again; see the
follow-up below. Previously valid messages remain readable after
their credential expires; reader verification remains tied to send time.

The new regression failed before the fix because sending resolved successfully
after expiry. It now checks refusal before publication, refusal of preparation,
renewal and fresh-device replay of both valid messages.

### Follow-up, 28 October: renewal after sleep

A tester met the new refusal the next morning and had to rejoin. The
credential had expired while the laptop slept: renewal was a single
`setTimeout` computed from the wall clock, and Chromium, Electron and Node
run timers on a monotonic clock that can stand still while the computer is
suspended (Chromium `base/time/time.h`: "TimeTicks may 'stand still' (e.g.,
if the computer is suspended)"). The laptop woke with an expired credential
and a renewal timer with hours of awake time left.

Renewal is now driven by the wall clock as well as the timer. Every
heartbeat (within twenty seconds of waking) and every visibility, focus,
`pageshow` and `online` event calls `RoomSession.checkCredential()`, which
renews at once when the credential is past its renewal point. No roster
entry is published under an expired credential. A send that meets an
expired credential renews first (`RoomSession.ensureCredential()`), keeping
the draft in the message box, and then sends. `ChatLog.send` does the same
for control and channel messages. Only a renewal that genuinely fails is
reported, in words that name the signer, storage or pairing problem; the
person is never told to rejoin. The guarantee above stands: nothing is
signed under an expired credential.

Messages written before 27 October under an expired credential were
accepted by relays and refused by every reader. They cannot be recovered.

## Android: overflowing receive buffer

Companion branch `fix/message-replay-loss-20261027` in `kithmoot-android` fixes a
separate receive-path defect. The original regression delivered only 256 of a
600-event history replay. IDs were admitted to duplicate suppression before
buffer admission, making later copies of dropped events ineligible.

Recovery retains the bounded buffer, excludes failed admissions from duplicate
suppression and reopens history after draining. Each retry has a fresh wire
subscription ID, retains the original history window and preserves successful
IDs. Keeper request repetition rules remain unchanged. Recovery has a bounded
budget; exhausted or overflowed reads do not assert complete history. This does
not add general remote history pagination beyond the existing deduplication
window.

## Acceptance boundaries

These changes do not establish what happened to the tester's particular
messages. The initial diagnosis did not perform a production release or physical
phone-to-desktop acceptance. Subsequent release qualification is recorded in
`docs/evidence/android-0.6.120-candidate-20261027.json` and
`docs/evidence/desktop-0.1.108-candidate-20261027.json`. An expired-credential message cannot be made
valid by relaxing reader checks. Recovering a dropped valid message still
requires a relay or device to retain its original event.

Required field check: send numbered messages in both directions, leave the
other device closed, reopen it, compare every number, then repeat after a
network interruption and a device sleep/credential-renewal interval. Record
exact versions, room identity, times and relay diagnostics for any gap.

## Local validation

- `node node_modules/vitest/vitest.mjs run src/chat.test.ts src/session.test.ts src/session-native-binding.test.ts app/src/pending-sends.test.ts --maxWorkers=2`: 201 passed.
- `npm run typecheck`: passed for the library and app.
- Android companion checks are recorded in its own investigation note.
- No public messages, release artefacts or device installations were created.

## Release allocation

Desktop 0.1.108 carries the credential check. Android 0.6.120, code 143,
reserves the receive-buffer fix after the already allocated 0.6.119 playback
release. Publication and device acceptance are tracked separately.

Desktop packaging also updates Electron within major 44 to 44.9.3, carrying
the TLS certificate mitigation required by
[GHSA-jr5w-w6x2-84p9](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9).
The packager's transitive Undici is updated within major 7 for
[GHSA-xjj6-f33q-929c](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c).
These were identified by the release dependency audit; packaging and desktop
checks must run on the resulting pins.
