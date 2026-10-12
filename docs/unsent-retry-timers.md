# Preserve an unsent message's automatic retry

A pending message waiting for a connection, or retrying after a refusal,
used a one-shot timer to call the queue's global `wake()`. If the observed
wall clock had not reached `retryAt` yet, `wake()` skipped the record and
left it without another timer. The surviving message could remain pending
after the relay returned.

Each scheduled retry now checks its original record and deadline. An early
callback schedules the remaining wait; a due callback attempts that record.
Removed or replaced records, inactive rooms and records no longer waiting
stop. Retry periods, explicit retries, signed events, accepted-message display,
state checks and the optional send-delay window retain their existing behaviour.
No permanent polling loop or transport change is introduced.

The actual queue fails two controlled one-millisecond-early cases before
correction: connection polling and refusal backoff. After correction they
publish once at the deadline; separate removal/replacement controls prevent
an old callback from sending or re-arming a superseded record.

This measured queue defect is distinct from the earlier main-branch Firefox
edit/delete timeout. The unchanged scenario passes three baseline runs on
fac513c, whose hosted CI also passes all twelve jobs. Those results do not
attribute the earlier failure to timer timing. Keep that failure evidence and
its original 30-second deadline; the complete unchanged chat reliability
fixture remains required for this correction.

Local verification passes all 19 queue controls, typecheck, and all six
unchanged chat reliability cases in each of Firefox and Chromium. Local
WebKit cannot qualify the change: page creation reports
`Unknown setting: PushAPIEnabled` on macOS 14.6.1. Its failed traces are
retained; the same-head hosted WebKit jobs remain required.
