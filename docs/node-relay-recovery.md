# Failed Node relay handshakes

A connection timeout can leave a WebSocket in CONNECTING after nostr-tools
has removed its listeners. The pool closes that abandoned socket to avoid
accumulating live handshakes. Node ws emits an asynchronous error for this
closure, so a synchronous try/catch alone cannot prevent a headless agent
from terminating.

The closure boundary now attaches a temporary Node socket error observer and
removes it when the socket closes, or if close throws synchronously. Existing
observers remain attached. Browser sockets keep their ordinary close path.
The original failed connection still rejects; relay backoff, the 20-second
publication retry budget and acknowledgement requirements are unchanged.

A real Node ws child against an unfinished loopback HTTP upgrade reproduces
the original fatal exit. The corrected fixture exercises natural retries,
requires every client socket to close, checks observer cleanup and existing
observers, and verifies unrelated uncaught exceptions still terminate. It
creates no key files and contacts no public relay. Its child bound allows the
existing 20-second publication budget to finish; the earlier 15-second harness
was too short and omitted timeout signals from its exit result. Existing
production and test deadlines have not changed.
