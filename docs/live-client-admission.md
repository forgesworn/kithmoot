# Fresh mesh admission owner and epoch gate

A verified live invitation answer supplies epoch-zero capability and a hint. It
must not release room presence or chat. A new client must then ask the pinned
root's authenticated epoch desk, including when the hint is zero. Member replay,
a member's catch-up grant, a timer and EOSE cannot substitute for this initial
root check. Refuse a grant below the greatest known epoch/hint. Ordinary joined
members retain their existing member-assisted recovery.

The live challenge owner uses the caller's explicit transport and a stable local
device identifier. Allow one outstanding challenge per device/room, with a small
process-wide cap. Generate a fresh ephemeral reply key; send the identical
signed request at most at 0, 30 and 60 seconds. A 90-second monotonic deadline,
request expiry and observed wall-clock rollback can only shorten the exchange.
Never persist the reply key. On success, cancellation, retirement or timeout,
remove subscriptions/timers, release ownership and wipe the local key buffer.
Consume success once, bound incoming work before crypto, and ignore EOSE.
Silence never enables Internet fallback.

The initial epoch request has its own bounded owner and abort signal. The
existing epoch desk answers a request ID once, so a lost grant cannot be
recovered by resending that ID. Make at most three fresh epoch requests within
one deadline; accept only the pinned root and the current request ID, discarding
late grants to earlier requests. This differs from the durable invitation
challenge, whose original signed request and cached answer must be reused.
Keep unknown/removed policy intact and stop all work on cancellation. Until
it succeeds, only admission control traffic may be published. Leaving while the
gate is pending must never resume room entry when a late answer arrives.

Tests must cover dropped initial offers, duplicate replies, wrong/expired
answers, abort during handoff, no peers, time rollback, resource caps, zero-epoch
silence/refusal, stale epoch hints, authenticated success and no pre-gate roster
or chat. The lab then uses actual room sessions over shared SimMesh, including
keeper/client restart. This owner does not itself supply a multi-room responder
budget, Android UI, complete-history queries, physical BLE or LoRa evidence.
