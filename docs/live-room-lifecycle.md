# Bind the live journal to a root room

The durable journal must own root transitions before the live request/answer
profile can be enabled. Add an explicit `liveKeeper` option to `RoomAgent.create`.
It transfers ownership of the journal to the agent and requires a caller-supplied
transport. Derive the room and fixed relay policy from the journal, never a
second keeper export or the default Internet relays. Refuse conflicting state,
lifetime, persistence callbacks and quiet-room wrapping. Recover pending original
control events before constructing a session; never start a closed journal.

A new optional RoomSession rekey transaction receives the signed event, next
secret and decoded notice before publication. Serialize rekeys, persist through
the journal, offer its retained events, and only then move the session. Failure
stops the session and its desks; recovery requires reopening the journal. While
a transition is in progress, refuse ordinary transport publications. Existing
bytes already handed to a transport cannot be recalled. A successful callback
means local handoff, not a remote receipt. A durable radio courier is still
needed when a transport cannot confirm retention.

Persist same-epoch membership, credentials, channels and history separately,
without permitting changes to authority, epoch secret, removals or lifecycle.
Closing stages its retirement and rekey together; retirement remains durable
without closing an otherwise usable room. On every failure, stop normal output
before cleanup, and retain pending state. A journal error cannot be swallowed
as an optional post-publication persistence notification.

A live-journal agent must not run the legacy delegated invitation responder or
republish kind 1463 on restart. Its epoch desk remains available for authenticated
member recovery, with the existing unknown/removed policy. A reply-key challenge
cannot call `letIn`. Keep the new live admission responder disabled until its
bounded requester, aggregate durable quotas and authenticated epoch-zero gate
are integrated. This increment supplies the root transaction boundary; it does
not yet enable a new client route.

Acceptance: actual RoomAgent/RoomSession rekey, closed and retired restart;
uncertain handoff retains exact ID/secret and terminates the old session;
concurrent rekeys cannot mint competing transitions; pending state cannot send
ordinary chat or answer from the old epoch; metadata survives restart and cannot
change authority; startup drains before roster publication; no legacy invitation
response or implicit relay fallback. Broader CI remains required before merge.

## Local evidence

Thirty focused tests across four files pass, including eleven root-room cases
and five real child-process SIGKILL scenarios. The integrated keeper killed
inside its rekey handoff reopens and offers the original event before any new
roster publication. Other cases cover uncertain writes, retirement/closure,
metadata restoration, competing rekeys, incoming new-epoch chat during handoff,
exclusive journal binding, constructor cleanup and absent Internet fallback.

The lease fixture now retains its idle journal explicitly and forces garbage
collection before a competing-process check. An unreachable store can be
collected and release its native database connection while its process remains
alive; process liveness alone was an insufficient fixture ownership assertion.
Library compilation passes. Application type checking passed before the final
constructor-cleanup change. The broader local affected-suite run recorded an
existing five-second admin-removal timeout and the earlier lease-fixture failure;
it is not claimed green. Full hosted CI remains the merge gate.
