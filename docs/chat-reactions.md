# Encrypted chat reactions

A reaction is an optional `reaction` object inside the existing encrypted kind-1460 chat payload. It uses the same room or named-channel key, sender device signature, participant credential, admission checks, retention and rate limits as a message. No public kind-7 event, target tag or participant tag is published.

```json
{"messageId":"original-message-id","participant":"original-sender-64-character-hex-key","emoji":"❤️","active":true,"revision":1}
```

`messageId` is 1–128 characters. `participant` is a 64-character hexadecimal key, normalised to lower case. `emoji` is one of 👍 ❤️ 🤦 😂 🎉 👀 🙏 😢. `active` is a JSON boolean and `revision` is an integer from 1 to 2147483647. Invalid reactions are refused. A reaction cannot also carry a transcript/directive marker or attachments.

The envelope's authenticated participant is the person reacting; `reaction.participant` identifies the original message's sender. Reactions are matched only against loaded messages in the same conversation by both message ID and original sender. For each reacting participant, target and emoji, the greatest revision wins; ties use `sentAt`, then lexicographic message ID. All devices of the same participant share one vote. Removing a reaction publishes `active:false` with the next revision, preserving the update so an older add cannot resurrect it. Rapid toggles therefore work within the same second. Concurrent devices converge after receiving each other's updates.

The required text is a readable fallback, for example `Reacted ❤️ to message abc` or `Removed reaction ❤️ from message abc`. Older clients show that text as an ordinary message. Updated clients display counts beneath the target and omit updates from conversation search. Unknown or expired targets do not create a standalone reaction row. The existing 500-event history bound includes reaction updates.

In the web client, hold a message bubble for 450 ms or use its reaction button to open the emoji choices. Moving or scrolling cancels the hold. The picker follows the original message through incoming edits and preserves the reader's position and unfinished draft. Choosing an additional emoji keeps existing reactions; choosing one already selected removes it. Adding a reaction gives a brief animated flourish unless reduced motion is requested.

Hovering or focusing a reaction count shows a separate row for each reacting participant: kind-0 picture (or initials), name, checked NIP-05 when available, full npub and reaction time. Agent receipts retain their received time and connection-only explanation. The card can be hovered and scrolled without disappearing. The existing profile-lookup setting controls external picture and NIP-05 loading.
