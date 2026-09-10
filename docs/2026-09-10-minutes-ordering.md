# Minutes ordering across a send boundary

Node 24 in hosted run `34428711287` failed the long-minutes test: the first
two parts both had timestamp `1789006580`. The other 1,638 tests passed;
Node 22 passed the full suite. This was a real send-ordering race.

The scribe waited for a new second between parts but recorded that second
before calling the channel. Work inside a send could cross the boundary
before the message acquired its timestamp. The next part then appeared to
be in a later second while actually reusing the first part's timestamp.
Messages tied on timestamps sort by random id, so readers could receive the
parts in the wrong order.

The scribe now records the clock after each completed send. The next part
waits beyond that second. The existing acceptance test deliberately delays
the first send across a second boundary and retains its exact reconstruction,
part-count, size and strictly increasing timestamp assertions. It reproduced
the duplicate timestamp before the repair, then all nine scribe tests passed
with the repair. Full hosted candidate checks remain required.
