# Browser keeper box-clock evidence

`BrowserMlsKeeperBoxClock` is a development-only, explicit read-only probe for
future grant recovery. Construction performs no I/O. It cannot withdraw a
grant, prune the ledger, write a persona record or release an MLS send hold.
Production MLS remains disabled.

The caller owns an independent `BrowserMlsBoxClient` and its verified paired
Link endpoint. Its current predicate must cover the exact installed route,
account and privacy lifetime; invalidate the probe and close that endpoint on
transitions. Never borrow the persona witness endpoint or run this probe inside
a persona transaction. Actual endpoint/account composition remains separate.

The probe copies and validates the signed grant, binds its issuer to the current
foreground keeper, and compares the box client's immutable route ID and box
identity. One capabilities read precedes a valid fetch of a domain-separated,
deterministic probe mailbox. Another capabilities read follows. Both must
succeed with the same installation. Only a positive authenticated fetch's
`server_time` becomes box-time evidence. Capabilities carry no time; refusal
timestamps, unavailable transport and malformed replies supply no evidence.
The probe ignores and wipes fetched records, follows no cursor and performs no
acknowledgement, deposit or automatic retry.

Account, foreground and client/route guards surround every await. Phone time
must be a safe nonnegative integer and cannot regress during or between probes
in the same lifetime. The observation retains the final phone time, signed
grant expiration/reference, box identity, installation and captured vault
binding. It is an authenticated local observation, not a signed box receipt.
The phone clock is an explicit trust assumption; its lifetime floor is not a
persistent witness floor or a detector of a frozen/slow clock.

The whole probe has a bounded 20-second default deadline (1 ms to 60 seconds
configurable). Only one underlying probe may remain outstanding. Timeout or
invalidation returns without accepting late results; another probe refuses
until abandoned signer/transport work settles. The underlying client retains
its own operation bounds. Endpoint shutdown remains the caller's responsibility.

Dual-clock recovery must separately recheck final phone time, account,
foreground, exact signed grant bytes and approval on witnessed reentry. A grant
can lapse only when its signed expiration is no later than the lesser of that
final trusted phone time and authenticated box time. The exact `no-live`
outcome must be witnessed before compare-and-delete pruning. Neither missing
storage nor a forgotten route proves lapse or revocation. Expired `revoking`
renewal, pruning/completion, operator UI and runtime composition remain open.

Local tests use the real strict box client with simulated transport. Browser
cases use the genuine WASM capabilities parser and coordinated vault, validating
each NIP-98 request's signature, signer, route and body hash. They cover positive
time, a box ahead of the phone, refusal time ignored, installation replacement,
account invalidation and clock rewind. These are deterministic local fixtures,
not live Bothy, deployed, authenticated production-browser or physical acceptance.
