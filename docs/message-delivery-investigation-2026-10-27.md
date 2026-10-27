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
clearing its draft. The error asks the person to rejoin. Normal credential
renewal enables sending again. Previously valid messages remain readable after
their credential expires; reader verification remains tied to send time.

The new regression failed before the fix because sending resolved successfully
after expiry. It now checks refusal before publication, refusal of preparation,
renewal and fresh-device replay of both valid messages.

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
messages. No production release or physical phone-to-desktop acceptance has
been performed by this task. An expired-credential message cannot be made
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
