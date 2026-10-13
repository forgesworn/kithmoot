# Girnel Boards in KithMoot

Boards replaces the user-facing Work destination. Girnel remains usable on its
own; KithMoot hosts the same durable, encrypted shared board implementation.

Delivery is complete only when the following journeys are implemented, tested
at their actual boundary and published:

1. Boards is available from home, project/room navigation and mobile navigation;
   Inbox retains attention items and existing assignments remain discoverable.
2. People can create, join, edit and share real Girnel boards inside KithMoot.
   Project and chat association is explicit and does not change board membership.
3. Several boards from different projects/chats can open in separate windows.
   Their visible headers and window titles retain project, chat and board context.
   Switching the main room leaves those windows bound to their original context.
4. Multiple admitted people and agents can work concurrently. Remote edits
   converge; local drafts survive updates; authors and assignment ownership remain
   visible. Same-device windows respect Girnel's durable writer fence and handoff.
5. A card can lead to its room discussion and existing signed agent assignment,
   progress, questions, exact result review and approved board changes. An agent's
   submitted result does not mark the work accepted.
6. Account changes, board/room removal, popup closure, reconnect, missing history
   and publication retries preserve the relevant authority and durable data.
7. Appropriate unit, browser, production-build, CI and live artifact gates pass.
   Separate web and installed desktop delivery evidence; do not claim native
   Android board parity from the web implementation.

Reuse Girnel's shared model, BoardSession, membership and relay implementation.
Reuse KithMoot's canonical assignment log and executor authority. Never copy keys
into URLs, room messages, model prompts or the window context directory.

Initial source baselines: KithMoot 7eec830; Girnel bbd4704. Original checkouts and
unrelated work are preserved in place.

The web app and desktop 0.1.78 were published on 13 October 2026. The
[publication receipt](evidence/girnel-boards-publication-2026-10-13.json) records
the exact CI/source, public files, signatures and live board-window check. Native
Android Boards remains outside this delivery.
