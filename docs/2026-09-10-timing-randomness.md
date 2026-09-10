# Timing randomness

Room entry replies and the agent's delayed connection receipt previously
used `Math.random()`. These timings are visible to a relay. Both now draw a
fresh unsigned 32-bit word from the platform CSPRNG and scale it into [0, 1).
The reply jitter range and the receipt's 1.5–3 second range stay unchanged.
There is no predictable fallback if the CSPRNG is unavailable.

Validation: type checking and all 1,661 tests (104 files) pass on Node 24,
including 71 focused session, runtime and randomness tests. The seven-repository
profile scan has zero failures and two host-constant warning groups; the timing
randomness warning is gone. This fixes the source of randomness, without
claiming measured timing defaults or anonymous traffic resistance.
