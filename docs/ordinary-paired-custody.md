# Browser and tab paired custody

`OrdinaryStateOwner.mutatePairMigrated` is an unmounted source primitive. It
commits final browser and tab images in one native `owners` transaction under
one origin Web Lock. It is not membership authority, independent rollback
resistance, or acceptance of the production startup path. DG08 remains open.

Both owners must be distinct, prepared, live, correctly scoped, and fully
migrated. The tab's canonical purpose and exact lease must be valid. A prior
single-owner pending intent is authenticated and promoted before the pair's
callback or encryption. Both lifetimes join the same operation promise.

The callback is synchronous and receives two separately revoked private
views plus frozen migration-name copies. Changes to both images must fit the
canonical codec limits before either nonce is generated. Both encrypted
candidates are ready before the transaction compares both prior frames and
authenticates both freshly read keys. Lightweight `getKey` requests keep that
same writer transaction alive across WebCrypto; an active native request
callback queues both puts after authentication. A key swap during sealing
therefore refuses both writes without repairing the corrupted source row.
There is no separate pair staging or promotion boundary.

An uncertain acknowledgement retains the origin lock and both exact frames.
Reconciliation reads both rows in one readonly transaction and authenticates
both keys and frames. Both candidates acknowledge custody; both prior images
prove a definite abort. Mixed, missing, pending, corrupt or unavailable
custody stays held. Either owner's retry continues the same operation without
rerunning the callback or encryption. Closing either owner immediately
stops its effects and joins reconciliation; closure, lease expiry or lost
foreground permission suppresses success even if both candidates committed.
Restart can authenticate those final records without replacing their keys.

The application still owes actual signed-event production and retention,
matching browser-proof and tab-admission identities, and complete startup
validation before effects. Bindings must include the operation, invitation,
contributing events, room root, account and device identities where applicable.
This primitive cannot make arbitrary records cross-bindable. A durable control
record is necessary if the final records cannot express that binding. Legacy
recovery, old-client capacity fencing, bootstrap and physical acceptance remain
separate gates.

Native tests run real IndexedDB, WebCrypto and Web Locks with synthetic
records. They cover atomic puts, queued-write aborts, lost acknowledgement,
uncertain mixed/corrupt states, exact retry, expiry, closure, pending-intent
recovery, capacity refusal before nonce, restart and competing pages. These
fixtures do not exercise real invitations, production adapters or independent
storage hardware.

The Fold-kit pin includes the optional persistent-invitation-evidence API.
The source tests currently use the previously reviewed local Signet 0.18.0
package; KithMoot's registry declaration remains 0.17.1. This substitution is
recorded in the external validation receipts. A reproducible published
consumer install and release remain open until the upstream dependency gate
is resolved.
